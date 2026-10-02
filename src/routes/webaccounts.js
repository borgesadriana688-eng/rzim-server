'use strict';

/**
 * Contas com usuario/senha (webaccounts).
 * Armazenamento simples em JSON (data/webaccounts.json), senha com salt SHA-256.
 * Cada conta tem um open_id deterministico (seeded por 'acct:<usuario>'),
 * entao o progresso fica preso a conta, nao ao aparelho.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'webaccounts.json');

let store = null;

function load() {
  if (store) return;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    store = {};
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(store));
  } catch (e) {
    /* sem volume: so perde em restart */
  }
}

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

function hashPass(salt, pass) {
  return crypto.createHash('sha256').update(salt + ':' + pass).digest('hex');
}

function seededOpenId(seed) {
  const b = crypto.createHash('sha256').update(String(seed)).digest();
  let out = '';
  for (let i = 0; i < 32; i++) out += '0123456789abcdefghijklmnopqrstuvwxyz'[b[i] % 36];
  return out;
}

// usuario valido: 3-16 chars, letras/numeros/_ .
function validUsername(u) {
  return /^[A-Za-z0-9_.]{3,16}$/.test(String(u || ''));
}

// cria conta; retorna {ok} ou {erro}
function createAccount(username, password, nickname) {
  username = String(username || '').trim();
  if (!validUsername(username)) return { erro: 'Usuário inválido (3-16 letras/números/_)' };
  password = String(password || '');
  if (password.length < 4) return { erro: 'Senha muito curta (mínimo 4)' };
  load();
  if (store[username.toLowerCase()]) return { erro: 'Esse usuário já existe' };
  const salt = crypto.randomBytes(8).toString('hex');
  const acc = {
    username: username,
    salt: salt,
    phash: hashPass(salt, password),
    nickname: String(nickname || username).slice(0, 16),
    open_id: seededOpenId('acct:' + username.toLowerCase()),
    created: nowSecs()
  };
  store[username.toLowerCase()] = acc;
  persist();
  return { ok: true, account: acc };
}

// verifica login; retorna account ou null
function verifyLogin(username, password) {
  load();
  const acc = store[String(username || '').trim().toLowerCase()];
  // migracao: contas antigas com openid de 18 digitos -> novo formato 32 chars
  if (acc && acc.open_id && !/^[0-9a-z]{32}$/.test(acc.open_id)) {
    acc.open_id = seededOpenId('acct:' + String(username || '').trim().toLowerCase());
    persist();
  }
  if (!acc) return null;
  if (hashPass(acc.salt, String(password || '')) !== acc.phash) return null;
  return acc;
}

function getAccount(username) {
  load();
  return store[String(username || '').trim().toLowerCase()] || null;
}

module.exports = { createAccount, verifyLogin, getAccount };
