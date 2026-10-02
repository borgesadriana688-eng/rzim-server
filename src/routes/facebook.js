'use strict';

/**
 * PONTE DO FACEBOOK — portada do servidor Flask que funcionava com o APK RZIM.
 *
 * O SDK do Facebook dentro do jogo (com.facebook *) faz:
 *   GET  /v9.0/dialog/oauth            → devolvemos 302 p/ fbconnect://success#...
 *   GET  /v9.0/me                      → perfil (id/name/email...)
 *   GET  /v9.0/<app_id>[/mobile_sdk_gk, /activities]  → mocks de analytics
 * E o jogo (GarenaMSDK) faz:
 *   POST /oauth/token/facebook/exchange (e google/line/twitter/vk/wechat)
 *
 * Detalhes criticos descobertos em debugging (set/2026):
 *  - o SDK exige access_token no redirect do dialog, senao AccessToken fica null → NPE;
 *  - o signed_request tem que ser base64 PADRAO (o SDK usa Base64.decode(...,0)),
 *    com payload {"algorithm":"HMAC-SHA256","issued_at":N,"user_id":"<open_id>"};
 *  - o exchange devolve tokens type=guest (o C# do jogo le o payload do token;
 *    "oauth" era rejeitado).
 */

const crypto = require('crypto');
const express = require('express');
const tracker = require('./guestTracker');
const webaccounts = require('./webaccounts');

const SECRET_KEY = process.env.SECRET_KEY || 'freefire_private_server_2024_hmac_key_fixed_v2';
const FB_APP_ID = process.env.FB_APP_ID || '2036793259884297';

const router = express.Router();

// ---------- helpers de token (identicos ao guest.js / ao Flask) ----------

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

function b64urlPad(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
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

function param(req, name, fallback) {
  const body = req.body || {};
  if (body[name] !== undefined && body[name] !== null && String(body[name]) !== '') return body[name];
  if (req.query && req.query[name] !== undefined && req.query[name] !== null) return req.query[name];
  return fallback === undefined ? '' : fallback;
}

function seededOpenId(seed) {
  const b = crypto.createHash('sha256').update(String(seed)).digest();
  let out = '';
  for (let i = 0; i < 32; i++) out += '0123456789abcdefghijklmnopqrstuvwxyz'[b[i] % 36];
  return out;
}

// guest do aparelho: rastreado por IP, senao um guest deterministico do IP
function deviceGuest(req) {
  const oid = tracker.lookupGuest(req);
  if (oid) return { open_id: oid, nickname: 'Guest' };
  return { open_id: seededOpenId('ip:' + tracker.clientIp(req)), nickname: 'Guest' };
}

// ---------- dialog/oauth (auto-login) ----------

router.get(/^\/v[0-9.]+\/dialog\/oauth$/, dialogHandler);
router.post(/^\/v[0-9.]+\/dialog\/oauth$/, dialogHandler);
router.get(/^\/v[0-9.]+\/[0-9]+\/dialog\/oauth$/, dialogHandler);
router.post(/^\/v[0-9.]+\/[0-9]+\/dialog\/oauth$/, dialogHandler);

// monta o redirect fbconnect://success#... com os campos que o SDK exige
function goRedirect(res, redir, state, openId, nickname) {
  const at = createToken(openId, nickname, 'guest');

  // ATENCAO: o SDK usa Base64.decode(..., 0) = base64 PADRAO (nao url-safe).
  const payloadJson = JSON.stringify({
    algorithm: 'HMAC-SHA256',
    issued_at: nowSecs(),
    user_id: String(openId)
  });
  const payload = Buffer.from(payloadJson).toString('base64');
  const sig = Buffer.from(
    crypto.createHmac('sha256', SECRET_KEY).update(payload).digest()
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signedRequest = sig + '.' + payload;

  const frag = {
    access_token: at,
    expires_in: '5184000',
    signed_request: signedRequest,
    graph_domain: 'facebook',
    granted_scopes: 'public_profile,user_friends,email',
    denied_scopes: '',
    data_access_expiration_time: String(nowSecs() + 5184000)
  };
  if (state) frag.state = state;

  const qs = Object.keys(frag)
    .map((k) => k + '=' + encodeURIComponent(String(frag[k])))
    .join('&');

  console.log('[DIALOG] login OK: ' + openId + ' (' + nickname + ')');
  res.redirect(302, redir + '#' + qs);
}

// ---------- pagina de login do dialog (abre DENTRO do jogo) ----------

function dialogPageHtml(redir, state, msg, erro) {
  const g = { nick: 'Convidado' };
  const msgHtml = msg ? '<div class="ok">' + esc(msg) + '</div>' : '';
  const errHtml = erro ? '<div class="erro">' + esc(erro) + '</div>' : '';
  const guestUrl = '/dialog/guest?redirect_uri=' + encodeURIComponent(redir) + (state ? '&state=' + encodeURIComponent(state) : '');
  return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">'
    + '<title>RZIM - Entrar</title><style>'
    + 'body{margin:0;background:#111;font-family:system-ui,sans-serif;color:#eee;padding:16px}'
    + '.card{max-width:420px;margin:0 auto;background:#1b1b1b;border-radius:14px;padding:20px 18px}'
    + 'h1{font-size:20px;margin:4px 0 14px;color:#ff9800}'
    + 'input{width:100%;box-sizing:border-box;padding:11px;margin:6px 0;border-radius:9px;border:1px solid #333;background:#262626;color:#eee;font-size:15px}'
    + 'button{width:100%;padding:12px;margin-top:8px;border:0;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer}'
    + '.bt-ok{background:linear-gradient(90deg,#ff9800,#ff5722);color:#111}'
    + '.bt-guest{background:#2e2e2e;color:#bbb;margin-top:14px}'
    + 'small{color:#888;display:block;text-align:center;margin-top:12px}'
    + '.ok{color:#8bc34a;text-align:center;margin-bottom:8px;font-size:14px}'
    + '.erro{color:#ff5252;text-align:center;margin-bottom:8px;font-size:14px}'
    + '.sep{color:#444;text-align:center;margin:14px 0 4px;font-size:12px}'
    + '</style></head><body><div class="card">'
    + '<h1>RZIM 2022 - Entrar</h1>'
    + msgHtml + errHtml
    + '<form method="post" action="/dialog/do_login">'
    + '<input type="hidden" name="redirect_uri" value="' + esc(redir) + '">'
    + (state ? '<input type="hidden" name="state" value="' + esc(state) + '">' : '')
    + '<input name="usuario" placeholder="Usuário" autocapitalize="none">'
    + '<input name="senha" type="password" placeholder="Senha">'
    + '<button class="bt-ok" type="submit">Entrar</button></form>'
    + '<div class="sep">ou</div>'
    + '<a href="' + guestUrl + '"><button class="bt-guest" type="button">Continuar como Convidado</button></a>'
    + '<div class="sep">não tem conta?</div>'
    + '<form method="post" action="/dialog/do_create">'
    + '<input type="hidden" name="redirect_uri" value="' + esc(redir) + '">'
    + (state ? '<input type="hidden" name="state" value="' + esc(state) + '">' : '')
    + '<input name="usuario" placeholder="Novo usuário" autocapitalize="none">'
    + '<input name="senha" type="password" placeholder="Nova senha">'
    + '<input name="nick" placeholder="Nome no jogo (opcional)">'
    + '<button class="bt-ok" type="submit">Criar conta e entrar</button></form>'
    + '<small>Servidor RZIM privado</small>'
    + '</div></body></html>';
}

function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function dialogHandler(req, res) {
  const redir = param(req, 'redirect_uri') || 'fbconnect://success';
  const state = param(req, 'state');
  res.send(dialogPageHtml(redir, state, null, null));
}

// form dentro do jogo: login
router.post('/dialog/do_login', (req, res) => {
  const redir = param(req, 'redirect_uri') || 'fbconnect://success';
  const state = param(req, 'state');
  const acc = webaccounts.verifyLogin(param(req, 'usuario'), param(req, 'senha'));
  if (!acc) {
    return res.send(dialogPageHtml(redir, state, null, 'Usuário ou senha errados'));
  }
  goRedirect(res, redir, state, acc.open_id, acc.nickname);
});

// form dentro do jogo: criar conta e entrar
router.post('/dialog/do_create', (req, res) => {
  const redir = param(req, 'redirect_uri') || 'fbconnect://success';
  const state = param(req, 'state');
  const r = webaccounts.createAccount(param(req, 'usuario'), param(req, 'senha'), param(req, 'nick'));
  if (!r.ok) {
    return res.send(dialogPageHtml(redir, state, null, r.erro));
  }
  goRedirect(res, redir, state, r.account.open_id, r.account.nickname);
});

// botao continuar como convidado
router.get('/dialog/guest', (req, res) => {
  const redir = param(req, 'redirect_uri') || 'fbconnect://success';
  const state = param(req, 'state');
  const g = deviceGuest(req);
  goRedirect(res, redir, state, g.open_id, g.nickname || 'Guest');
});

// ---------- pagina /conta (navegador: criar/entrar) ----------

router.get('/conta', (req, res) => {
  res.send(dialogPageHtml('fbconnect://success', '', null, null));
});

router.post('/conta/entrar', (req, res) => {
  const acc = webaccounts.verifyLogin(param(req, 'usuario'), param(req, 'senha'));
  if (!acc) return res.send(dialogPageHtml('', '', null, 'Usuário ou senha errados'));
  res.send(dialogPageHtml('', '', 'Login OK: ' + acc.nickname + ' (' + acc.open_id + ')', null));
});

router.post('/conta/criar', (req, res) => {
  const r = webaccounts.createAccount(param(req, 'usuario'), param(req, 'senha'), param(req, 'nick'));
  if (!r.ok) return res.send(dialogPageHtml('', '', null, r.erro));
  res.send(dialogPageHtml('', '', 'Conta criada: ' + r.account.nickname, null));
});

// ---------- exchange (GarenaMSDK → sessao do jogo) ----------

function exchangeHandler(platform) {
  return (req, res) => {
    const tok = param(req, platform + '_access_token');
    let openId = null;
    let nickname = 'Guest';
    let createTime = nowSecs();
    if (tok) {
      const d = verifyToken(tok);
      if (d) {
        openId = d.open_id;
        nickname = d.nickname || 'Guest';
        createTime = d.created || createTime;
      }
    }
    if (!openId) {
      const g = deviceGuest(req);
      openId = g.open_id;
      nickname = g.nickname || 'Guest';
    }
    // uid numerico estavel (mesma regra do /oauth/token/inspect do guest.js)
    let uid = 10000001;
    try { uid = Number(BigInt(String(openId)) % 100000000000000n); } catch (e) {}
    // SHAPE: espelha o connect.py original (codigo de plataforma guest = 4).
    // Antes devolviamos platform:"guest" -> optInt=0 e o jogo rejeitava.
    res.json({
      access_token: createToken(openId, nickname, 'guest'),
      code: 0,
      create_time: createTime,
      expires_in: 1296000,
      expiry_time: nowSecs() + 1296000,
      main_active_platform: 4,
      open_id: openId,
      platform: 4,
      refresh_expiry_time: nowSecs() + 2592000,
      refresh_token: createRefreshToken(openId, nickname, 'guest'),
      scope: ['get_user_info', 'get_friends', 'payment', 'send_request'],
      token_type: 'Bearer',
      uid: uid
    });
  };
}

router.all('/oauth/token/facebook/exchange', exchangeHandler('facebook'));
router.all('/oauth/token/google/exchange', exchangeHandler('google'));
router.all('/oauth/token/line/exchange', exchangeHandler('line'));
router.all('/oauth/token/twitter/exchange', exchangeHandler('twitter'));
router.all('/oauth/token/vk/exchange', exchangeHandler('vk'));
router.all('/oauth/token/wechat/exchange', exchangeHandler('wechat'));

// ---------- graph /me (perfil apos login) ----------

router.all(/^\/v[0-9.]+\/me$/, meHandler);
router.all(/^\/v[0-9.]+\/[0-9]+\/me$/, meHandler);

function meHandler(req, res) {
  let tok = param(req, 'access_token');
  if (!tok) {
    const a = req.headers['authorization'] || '';
    if (String(a).startsWith('Bearer ')) tok = a.slice(7);
  }
  let openId = null;
  let nickname = 'Guest';
  if (tok) {
    const d = verifyToken(tok);
    if (d) {
      openId = d.open_id;
      nickname = d.nickname || 'Guest';
    }
  }
  if (!openId) {
    const g = deviceGuest(req);
    openId = g.open_id;
    nickname = g.nickname || 'Guest';
  }
  // SHAPE: a referencia (FreeFireServer) devolve id = uid numerico no /me,
  // nao o open_id. Mantem consistencia com o exchange.
  let uid = 10000001;
  try { uid = Number(BigInt(String(openId)) % 100000000000000n); } catch (e) {}
  res.json({
    id: String(uid),
    name: nickname,
    first_name: nickname,
    last_name: '',
    email: String(nickname).toLowerCase() + '@freefire.local',
    email_verified: true,
    verified: true,
    birthday: '01/01/2000',
    gender: 'male',
    picture: { data: { url: '', is_silhouette: true, height: 200, width: 200 } }
  });
}

// ---------- mocks de graph (config do app / gatekeepers / activities) ----------

router.get(/^\/v[0-9.]+\/[0-9]+$/, (req, res) => {
  res.json({
    android_dialog_configs: {},
    android_sdk_error_categories: [],
    gdpv4_nux_content: {},
    gdpv4_nux_enabled: false,
    id: FB_APP_ID,
    supports_implicit_sdk_logging: true
  });
});

router.get(/^\/v[0-9.]+\/[0-9]+\/mobile_sdk_gk$/, (req, res) => {
  res.json({ data: [], id: FB_APP_ID });
});

router.post(/^\/v[0-9.]+\/[0-9]+\/activities$/, (req, res) => {
  res.json({ success: true });
});

module.exports = router;
