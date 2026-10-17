'use strict';

// lobby_local.js — tela de login MONTROY servida DIRETO do Termux.
// O cliente 1.27 carrega /dialog/oauth no root do SDK (http://127.0.0.1:18000),
// entao a pagina, o captcha, o login e o registro rodam tudo local — zero
// dependencia de Render/DNS.
//
// Conta: o usuario determina um open_id estavel (seededOpenId "user:<nome>"),
// entao cada nome de login sempre abre o mesmo perfil. O token usa o MESMO
// formato do guest.js (payloadB64.hmac), entao o verifyToken do proprio
// servidor aceita de cara.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SECRET_KEY = process.env.SECRET_KEY || 'freefire_private_server_2024_hmac_key_fixed_v2';

const router = express.Router();

let PAGE;
try {
    PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'login_pv.html'));
} catch (e) {
    PAGE = Buffer.from('<h1>login_pv.html nao encontrado</h1>');
}

function nowSecs() {
    return Math.floor(Date.now() / 1000);
}

// b64url igual ao guest.js (padding mantido)
function b64urlPad(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(p) {
    return crypto.createHmac('sha256', SECRET_KEY).update(p).digest('hex');
}

function seededOpenId(seed) {
    const h = crypto.createHash('sha256').update(String(seed)).digest('hex');
    return BigInt('0x' + h).toString().slice(0, 18).padStart(18, '0');
}

function accountToken(openId, nickname) {
    const payload = {
        open_id: openId,
        nickname: nickname,
        type: 'lobby',
        created: nowSecs(),
        expire: nowSecs() + 86400 * 60
    };
    const b = b64urlPad(Buffer.from(JSON.stringify(payload)));
    return b + '.' + sign(b);
}

function accountData(username) {
    const openId = seededOpenId('user:' + username);
    return {
        user_id: openId,
        open_id: openId,
        account_id: openId,
        access_token: accountToken(openId, username),
        expires_in: 86400 * 60,
        data_access_expiration_time: nowSecs() + 86400 * 60
    };
}

// ---------- captcha em memoria ----------
const CAP = new Map();

function newCaptcha() {
    const a = 1 + Math.floor(Math.random() * 9);
    const b = 1 + Math.floor(Math.random() * 9);
    const id = crypto.randomUUID();
    CAP.set(id, String(a + b));
    if (CAP.size > 200) CAP.delete(CAP.keys().next().value); // limpa antigos
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='130' height='44'>" +
        "<rect width='130' height='44' fill='#16162a' rx='8'/>" +
        "<text x='65' y='29' font-size='21' fill='#ffffff' text-anchor='middle' " +
        "font-family='monospace' letter-spacing='2'>" + a + " + " + b + " = ?</text></svg>";
    return {
        token: id,
        image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    };
}

// ---------- rotas ----------

router.get(['/dialog/oauth', '/dialog/oauth/', '/login.php', '/dialog/login', '/oauth/login'], (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(PAGE);
});

router.post(['/dialog/oauth', '/dialog/oauth/', '/oauth/login'], (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(PAGE);
});

// ---------- codes OAuth p/ o SDK beetalk (1.27) ----------
// O SDK abre /oauth/login?redirect_uri=gop<app>: //auth/, espera o redirect com
// code= e depois troca em POST /oauth/token/exchange esperando open_id/token.
const CODES = new Map();

router.post('/api/authcode', (req, res) => {
    const b = req.body || {};
    const openId = String(b.open_id || b.user_id || '').trim();
    const token = String(b.access_token || '').trim();
    if (!openId || !token) {
        return res.json({ success: false, message: 'Conta invalida.' });
    }
    const code = crypto.randomUUID();
    CODES.set(code, { open_id: openId, access_token: token, ts: Date.now() });
    if (CODES.size > 400) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [k, v] of CODES) if (v.ts < cutoff) CODES.delete(k);
    }
    res.json({ success: true, data: { code } });
});

function exchangeCode(req, res) {
    const b = req.body || {};
    const code = String(b.code || (req.query && req.query.code) || '').trim();
    const hit = CODES.get(code);
    CODES.delete(code); // uso unico
    if (!hit || Date.now() - hit.ts > 10 * 60 * 1000) {
        return res.json({ error: 'invalid_grant', error_description: 'Codigo invalido ou expirado.' });
    }
    res.json({
        open_id: hit.open_id,
        access_token: hit.access_token,
        refresh_token: hit.access_token,
        expiry_time: Math.floor(Date.now() / 1000) + 86400 * 60,
        platform: 0
    });
}
router.post('/oauth/token/exchange', exchangeCode);
router.get('/oauth/token/exchange', exchangeCode);

router.get('/api/captcha', (req, res) => res.json(newCaptcha()));

router.post('/api/login', (req, res) => {
    const b = req.body || {};
    const user = String(b.username || '').trim();
    const pass = String(b.password || '');
    if (!user || !pass) {
        return res.json({ success: false, message: 'Preencha usuário e senha.' });
    }
    res.json({ success: true, data: accountData(user) });
});

router.post('/api/register', (req, res) => {
    const b = req.body || {};
    const user = String(b.username || '').trim();
    const pass = String(b.password || '');
    const ct = String(b.captcha_token || '');
    const ca = String(b.captcha_answer || '').trim();
    const expected = CAP.get(ct);
    CAP.delete(ct); // captcha de uso unico
    if (!user || !pass) {
        return res.json({ success: false, message: 'Preencha todos os campos.' });
    }
    if (!expected) {
        return res.json({ success: false, message: 'Captcha expirado, toque em atualizar.' });
    }
    if (ca !== expected) {
        return res.json({ success: false, message: 'Resposta do captcha errada.' });
    }
    res.json({ success: true, data: accountData(user) });
});

module.exports = router;
