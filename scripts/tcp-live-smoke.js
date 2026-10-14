'use strict';
// Smoke AO VIVO do gateway TCP: sobe termux.js com redis real, registra/entra
// por HTTP, conecta o socket TCP 18002, faz handshake (AUTH), heartbeat e
// cria uma sala (RoomCreate protocol=14 cmd=2) conferindo a resposta.
const { RedisMemoryServer } = require('redis-memory-server');

(async () => {
  const rms = await RedisMemoryServer.create();
  const redisPort = await rms.getPort();
  process.env.REDIS_URL = 'redis://127.0.0.1:' + redisPort;
  console.log('[smoke] redis de teste na porta', redisPort);

  const { spawn } = require('child_process');
  const srv = spawn('node', ['termux.js'], {
    cwd: process.cwd(),
    env: { ...process.env, MAIN_PORT: '18001', TCP_PORT: '18002', TERMUX_HTTP_PORTS: '18000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  await new Promise((r) => setTimeout(r, 4000));

  // ---- HTTP: registro + login (pega token) ----
  const http = require('http');
  const { encrypt } = require('../src/protocol/aes');
  const { lookup } = require('../src/protocol/protos');
  const post = (endpoint, cipher, token) => new Promise((res, rej) => {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': cipher.length };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port: 18000, method: 'POST', path: `/${endpoint}`, headers }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', rej); req.write(cipher); req.end();
  });
  const call = async (endpoint, reqType, reqObj, resType, token) => {
    const Req = lookup(reqType);
    const cipher = encrypt(Buffer.from(Req.encode(Req.fromObject(reqObj || {})).finish()));
    const { status, body } = await post(endpoint, cipher, token);
    const Res = lookup(resType);
    return { status, decoded: Res.toObject(Res.decode(body), { longs: Number, enums: Number, defaults: true }) };
  };
  const base = { open_id: 'tcp-smoke-1', open_id_type: 1, nickname: 'TcpTester', device_id: 'dev-tcp', client_version: '1.70.0' };
  const reg = await call('MajorRegister', 'PlatformRegisterReq', { open_id: base.open_id, nickname: base.nickname, region: 'BR', language: 'pt', avatar_id: 101000001 }, 'MajorRegisterRes', null);
  const login = await call('MajorLogin', 'LoginReq', base, 'MajorLoginRes', null);
  if (login.status !== 200 || !login.decoded.token) throw new Error('login falhou: ' + login.status);
  console.log('[smoke] HTTP login ok, uid=', login.decoded.account_id);
  const token = login.decoded.token;

  // ---- TCP: gateway 18002 ----
  const net = require('net');
  const { CMD, encrypt: tEnc, decrypt: tDec } = require('../src/tcp/framing');
  const sock = net.connect(18002, '127.0.0.1');
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  console.log('[smoke] socket TCP conectado');

  const recvFrames = [];
  let pending = [];
  sock.on('data', (d) => { pending.push(d); const buf = Buffer.concat(pending); parseSrv(buf); });
  function parseSrv(buf) {
    let off = 0;
    while (buf.length - off >= 1) {
      if (buf[off] === 2) { recvFrames.push({ cmd: 2, payload: null }); off += 1; continue; }
      if (buf.length - off < 5) break;
      const len = buf.readUInt32BE(off + 1);
      if (buf.length - off < 5 + len) break;
      recvFrames.push({ cmd: buf[off], payload: buf.subarray(off + 5, off + 5 + len) });
      off += 5 + len;
    }
    pending = [buf.subarray(off)];
  }
  const waitFor = (pred, ms = 5000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const i = recvFrames.findIndex(pred);
      if (i >= 0) { clearInterval(iv); res(recvFrames[i]); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout esperando frame')); }
    }, 30);
  });

  // AUTH: cmd=1 region=1 payload=AES(token utf8)
  const authPayload = tEnc(Buffer.from(token, 'utf8'));
  const authFrame = Buffer.alloc(6 + authPayload.length);
  authFrame[0] = CMD.AUTH; authFrame[1] = 1; authFrame.writeUInt32BE(authPayload.length, 2);
  authPayload.copy(authFrame, 6);
  sock.write(authFrame);
  await waitFor((f) => f.cmd === 2, 4000);
  console.log('[smoke] AUTH ack 0x02 recebido');

  // HEARTBEAT
  sock.write(Buffer.from([CMD.HEARTBEAT, 1]));
  await waitFor((f) => f.cmd === 2, 3000);
  console.log('[smoke] HEARTBEAT ack 0x02 recebido');

  // RoomCreate: frame cmd=14 payload=AES(ProtoReq{cmd:2 data:RoomCreateReq})
  const RoomCreateReq = lookup('tcp.RoomCreateReq');
  const inner = Buffer.from(RoomCreateReq.encode(RoomCreateReq.fromObject({ room_name: 'Test', game_mode: 15, map_id: 1, room_setting: 0x2000000 })).finish());
  const ProtoReq = lookup('ProtoReq');
  const preq = Buffer.from(ProtoReq.encode(ProtoReq.fromObject({ cmd: 2, data: inner })).finish());
  const enc = tEnc(preq);
  const frame = Buffer.alloc(6 + enc.length);
  frame[0] = 14; frame[1] = 1; frame.writeUInt32BE(enc.length, 2);
  enc.copy(frame, 6);
  sock.write(frame);

  const resp = await waitFor((f) => f.cmd === 14, 5000);
  const MessageNotify = lookup('MessageNotify');
  const notify = MessageNotify.toObject(MessageNotify.decode(resp.payload), { longs: Number, enums: Number, defaults: true });
  console.log('[smoke] RoomCreate resposta: protocol=%s cmd=%s ret=%s content=%dB', notify.protocol, notify.cmd, notify.ret, (notify.content || []).length);
  const RoomInfo = lookup('tcp.RoomInfo');
  const info = RoomInfo.toObject(RoomInfo.decode(Buffer.from(notify.content || [])), { longs: Number, enums: Number, defaults: true });
  console.log('[smoke] RoomInfo:', JSON.stringify(info).slice(0, 400));
  const ok = info && (info.room_id || info.id || info.roominfo || info.base);
  if (!ok) throw new Error('sala sem room_id');
  console.log('=== TCP SMOKE AO VIVO: OK ===');
  sock.destroy();
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1000));
  await rms.stop();
  process.exit(0);
})().catch(async (e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
