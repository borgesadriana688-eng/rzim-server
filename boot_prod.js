'use strict';
const https = require('https');
const { encrypt } = require('./src/protocol/aes');
const { lookup } = require('./src/protocol/protos');

const HOST = 'captivating-magic-production-792c.up.railway.app';

function post(endpoint, cipher, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': cipher.length };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = https.request({ host: HOST, port: 443, method: 'POST', path: `/${endpoint}`, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(cipher);
    req.end();
  });
}

async function call(endpoint, reqTypeName, reqObj, resTypeName, token) {
  const ReqType = lookup(reqTypeName);
  const msg = ReqType.fromObject(reqObj || {});
  const plain = Buffer.from(ReqType.encode(msg).finish());
  const cipher = encrypt(plain);
  const { status, body } = await post(endpoint, cipher, token);
  let decoded = null, err = null;
  try {
    const ResType = lookup(resTypeName) || lookup('Empty');
    const m = ResType.decode(body);
    decoded = ResType.toObject(m, { longs: Number, enums: Number, defaults: true, arrays: true, objects: true });
  } catch (e) { err = e.message; }
  return { status, decoded, err, rawLen: body.length };
}

(async () => {
  const login = await call('MajorLogin', 'LoginReq', {
    open_id: '811778513637575881',
    open_id_type: 1,
    nickname: 'testebr',
    device_id: 'dev-prod-test',
    client_version: '1.71.0'
  }, 'MajorLoginRes', null);
  console.log('MajorLogin status=%d len=%d err=%s', login.status, login.rawLen, login.err);
  console.log(' ->', JSON.stringify(login.decoded));
  const token = login.decoded && login.decoded.token;
  if (!token) { console.log('NO TOKEN'); process.exit(1); }

  const ld = await call('GetLoginData', 'LoginReq', { account_id: login.decoded.account_id }, 'LoginRes', token);
  console.log('\nGetLoginData status=%d len=%d err=%s', ld.status, ld.rawLen, ld.err);
  console.log(' ->', JSON.stringify(ld.decoded));
})();
