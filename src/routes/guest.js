'use strict';

/**
 * Rotas do SDK (com.barbosa.msdk) portadas do servidor Flask que funcionava
 * com os clientes Barbosa. Fluxo GUEST AUTOMÁTICO, sem banco:
 * tokens stateless no formato base64(json).hmac_sha256 — idêntico ao Flask,
 * porque o jogo em C# lê o payload do token.
 *
 * Endpoints:
 *   POST /oauth/guest/register       — registra guest (open_id determinístico por device)
 *   POST /oauth/guest/token/grant    — re-emite tokens do guest
 *   POST /oauth/token                — refresh_token / authorization_code
 *   GET  /oauth/token/inspect       — inspeção de access token
 *   POST /oauth/logout               — logout
 *   GET|POST /oauth/user/info/get    — perfil do SDK
 *   GET|POST /oauth/user/friends/*   — amigos (vazio)
 *   GET|POST /me, /v2.5/me           — graph mínimo
 *   GET  /app/info/get               — info do servidor p/ o cliente
 *   POST /app/feedback               — ok
 *   POST /api/heartbeat              — heartbeat do SDK
 *   GET|POST /api/msdk               — config do SDK
 */

const crypto = require('crypto');
const express = require('express');

const SECRET_KEY = process.env.SECRET_KEY || 'freefire_private_server_2024_hmac_key_fixed_v2';
const GAME_VERSION = process.env.GAME_VERSION || '1.70.1';

const router = express.Router();

// ---------- helpers (iguais ao Flask) ----------

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

// b64url com padding igual ao python base64.urlsafe_b64encode
function b64urlPad(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_'); // mantém '=' padding
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET_KEY).update(payloadB64).digest('hex');
}

function createToken(openId, nickname, tokenType) {
  const payload = {
    open_id: openId,
    nickname: nickname,
    type: tokenType,
    created: nowSecs(),
    expire: nowSecs() + 86400 * 30
  };
  const payloadB64 = b64urlPad(Buffer.from(JSON.stringify(payload)));
  return payloadB64 + '.' + sign(payloadB64);
}

function createRefreshToken(openId, nickname, tokenType) {
  const payload = {
    open_id: openId,
    nickname: nickname,
    type: tokenType,
    rt: true,
    expire: nowSecs() + 86400 * 60
  };
  const payloadB64 = b64urlPad(Buffer.from(JSON.stringify(payload)));
  return payloadB64 + '.' + sign(payloadB64);
}

function verifyToken(token) {
  if (!token || String(token).indexOf('.') < 0) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (!payload.expire || payload.expire < nowSecs()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function verifyRefreshToken(token) {
  const d = verifyToken(token);
  return d && d.rt ? d : null;
}

// lê parâmetro de form / json / query (igual ao param() do Flask)
function param(req, name, fallback) {
  const body = req.body || {};
  if (body[name] !== undefined && body[name] !== null && String(body[name]) !== '') return body[name];
  if (req.query && req.query[name] !== undefined && req.query[name] !== null) return req.query[name];
  return fallback === undefined ? '' : fallback;
}

function genOpenId() {
  return String(BigInt('0x' + crypto.randomUUID().replace(/-/g, ''))).slice(0, 18).padStart(18, '0');
}

function seededOpenId(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest('hex');
  return BigInt('0x' + h).toString().slice(0, 18).padStart(18, '0');
}

function guestAccount(customNick, seed) {
  const openId = seed ? seededOpenId(seed) : genOpenId();
  const nickname = customNick || 'Guest' + Math.floor(Math.random() * 99999);
  return {
    open_id: openId,
    platform: 'guest',
    access_token: createToken(openId, nickname, 'guest'),
    refresh_token: createRefreshToken(openId, nickname, 'guest'),
    expiry_time: nowSecs() + 86400 * 30,
    expires_in: 86400 * 30,
    token_type: 'Bearer'
  };
}

function gameServerHost(req) {
  return (req.headers.host || 'localhost:443').split(',')[0].trim();
}

// ---------- rotas ----------

router.post('/oauth/guest/register', (req, res) => {
  const nickname = param(req, 'nickname') || null;
  const seed = param(req, 'uid') || param(req, 'device_id') || null;
  res.json(guestAccount(nickname, seed));
});

router.get('/oauth/guest/register', (req, res) => {
  const nickname = param(req, 'nickname') || null;
  const seed = param(req, 'uid') || param(req, 'device_id') || null;
  res.json(guestAccount(nickname, seed));
});

router.post('/oauth/guest/token/grant', (req, res) => {
  const seed = param(req, 'uid') || param(req, 'client_id') || null;
  res.json(guestAccount(null, seed));
});

router.get('/oauth/guest/token/grant', (req, res) => {
  const seed = param(req, 'uid') || param(req, 'client_id') || null;
  res.json(guestAccount(null, seed));
});

router.post('/oauth/token', (req, res) => {
  const grantType = String(param(req, 'grant_type', ''));
  const refreshToken = param(req, 'refresh_token', '');
  if (grantType === 'refresh_token') {
    const d = verifyRefreshToken(refreshToken);
    if (d) {
      return res.json({
        access_token: createToken(d.open_id, d.nickname, d.type || 'guest'),
        refresh_token: createRefreshToken(d.open_id, d.nickname, d.type || 'guest'),
        expires_in: 86400 * 30,
        token_type: 'Bearer'
      });
    }
    return res.json({ code: 2017, error: 'invalid_grant' });
  }
  if (grantType === 'authorization_code' || !grantType) {
    // mesma semântica do Flask antigo: devolve guest
    const seed = param(req, 'uid') || null;
    return res.json(guestAccount(null, seed));
  }
  return res.json({ code: 2017, error: 'invalid_grant' });
});

router.get('/oauth/token/inspect', (req, res) => {
  const token = req.query.token || '';
  const d = verifyToken(token);
  if (!d) return res.json({ code: 2017, error: 'invalid_grant' });
  res.json({
    expiry_time: d.expire,
    uid: Number(BigInt(d.open_id) % 100000000000000n),
    open_id: d.open_id,
    main_active_platform: 4,
    app_id: 100067,
    platform: 4,
    create_time: d.created || nowSecs(),
    scope: ['get_user_info', 'get_friends', 'payment', 'send_request'],
    login_type: 2,
    login_platform: 4
  });
});

router.get('/oauth/logout', (req, res) => {
  res.json({ success: 'true' });
});

function userInfoPayload(d) {
  return {
    open_id: d.open_id,
    platform: 'guest',
    icon: '',
    nickname: d.nickname || 'Player',
    gender: 1,
    level: 1,
    exp: 0,
    avatar: '',
    is_guest: true,
    created_time: d.created || nowSecs(),
    vip_level: 0,
    diamond: 0,
    gold: 0,
    coins: 0,
    rank: 'Bronze',
    region: 'BR',
    skin_ids: [],
    character_ids: [],
    weapon_skin_ids: [],
    pet_ids: [],
    badges: [],
    achievements: []
  };
}

router.post('/oauth/user/info/get', (req, res) => {
  const token = param(req, 'access_token', '');
  const d = verifyToken(token);
  if (!d) return res.json({ code: 1004, error: 'invalid_token' });
  res.json(userInfoPayload(d));
});

router.get('/oauth/user/info/get', (req, res) => {
  const token = param(req, 'access_token', '');
  const d = verifyToken(token);
  if (!d) return res.json({ code: 1004, error: 'invalid_token' });
  res.json(userInfoPayload(d));
});

router.post('/oauth/user/friends/get/v2', (req, res) => res.json({ friends: [], total: 0, pending: [] }));
router.get('/oauth/user/friends/get/v2', (req, res) => res.json({ friends: [], total: 0, pending: [] }));
router.post('/oauth/user/friends/info/get/v2', (req, res) => res.json({ friends: [], total: 0, pending: [] }));
router.get('/oauth/user/friends/inapp/get/v2', (req, res) => res.json({ friends: [], total: 0, pending: [] }));

// graph mínimo (o SDK chama /me com access_token)
function graphMe(req, res) {
  const token = req.query.access_token || (req.body && req.body.access_token) || '';
  const d = verifyToken(token);
  if (!d) return res.status(401).json({ error: { code: 190, message: 'Invalid OAuth access token' } });
  res.json({ id: d.open_id, name: d.nickname || 'Player', first_name: d.nickname || 'Player', last_name: '' });
}
router.get('/me', graphMe);
router.get(/^\/v[\d.]+\/me$/, graphMe);

router.get('/app/info/get', (req, res) => {
  res.json({
    client_log: false,
    status: 0,
    maintenance: false,
    version: GAME_VERSION,
    game_server: gameServerHost(req),
    update_url: '',
    notice: { title: 'Servidor Privado', content: 'Bem-vindo ao servidor!', show: true }
  });
});

router.post('/app/feedback', (req, res) => res.json({ success: true }));
router.get('/app/feedback', (req, res) => res.json({ success: true }));

router.post('/api/heartbeat', (req, res) => {
  const token = param(req, 'access_token', '');
  const d = verifyToken(token);
  if (!d) return res.json({ code: 1004, error: 'invalid_token' });
  res.json({ status: 'ok', server_time: nowSecs(), game_server: gameServerHost(req) });
});

router.get('/api/heartbeat', (req, res) => {
  res.json({ status: 'ok', server_time: nowSecs(), game_server: gameServerHost(req) });
});

router.post('/api/msdk', (req, res) => {
  res.json({
    status: 0,
    server_time: nowSecs(),
    game_server: { ip: gameServerHost(req), port: 443 },
    config: { version: GAME_VERSION, maintenance: false, notice: '' }
  });
});

router.get('/api/msdk', (req, res) => {
  res.json({
    status: 0,
    server_time: nowSecs(),
    game_server: { ip: gameServerHost(req), port: 443 },
    config: { version: GAME_VERSION, maintenance: false, notice: '' }
  });
});

router.post('/game/user/request/send', (req, res) => res.json({ success: true }));
router.post('/rebates/redeem', (req, res) => res.json({ success: true }));

module.exports = router;
