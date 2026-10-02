'use strict';
const https = require('https');
const aes = require('./src/protocol/aes');
const protos = require('./src/protocol/protos');

const HOST = 'captivating-magic-production-792c.up.railway.app';

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = https.request({ host: HOST, port: 443, path, method: 'POST', headers },
      (res) => { const ch = []; res.on('data', d => ch.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch) })); });
    req.on('error', reject); req.write(body); req.end();
  });
}
const enc = (type, obj) => aes.encrypt(Buffer.from(protos.lookup(type).encode(protos.lookup(type).fromObject(obj)).finish()));
const dec = (type, buf) => protos.lookup(type).toObject(protos.lookup(type).decode(buf), { longs: String, enums: Number, defaults: true });

(async () => {
  const openId = '811778513637575881';
  const loginReq = { open_id: openId, open_id_type: 1, plat_id: 1, language: 'pt', client_version: '1.71.0', nickname: 'testebr' };

  const r1 = await post('/MajorLogin', enc('LoginReq', loginReq));
  console.log('1. MajorLogin (fresh)  -> HTTP', r1.status);

  const r2 = await post('/MajorRegister', enc('PlatformRegisterReq', { nickname: 'testebr', open_id: openId, open_id_type: 1 }));
  let reg = {};
  for (const t of ['MajorRegisterRes', 'PlatformRegisterRes']) { try { reg = dec(t, r2.body); break; } catch (e) {} }
  console.log('2. MajorRegister       -> HTTP', r2.status, 'resp=' + JSON.stringify(reg));

  const r3 = await post('/MajorLogin', enc('LoginReq', loginReq));
  const log = dec('MajorLoginRes', r3.body);
  console.log('3. MajorLogin (known)  -> HTTP', r3.status, JSON.stringify(log));

  if (!log.token) { console.log('NO TOKEN - aborting'); return; }
  const r4 = await post('/GetLoginData', enc('LoginReq', loginReq), log.token);
  const acc = dec('LoginRes', r4.body);
  console.log('4. GetLoginData        -> HTTP', r4.status, JSON.stringify(acc));
})().catch(e => { console.error('ERR', e); process.exit(1); });
