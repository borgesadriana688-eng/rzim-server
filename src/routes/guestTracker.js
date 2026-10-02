'use strict';

/**
 * Rastreador de guest por dispositivo (por IP do cliente).
 * Portado do Flask (guest_ips.json): quando o aparelho registra um guest via
 * /oauth/guest/register, guardamos open_id <- IP. O dialog do Facebook e o
 * exchange usam isso pra logar o MESMO guest do aparelho automaticamente.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'guest_ips.json');

let map = null;

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

function load() {
  if (map) return;
  try {
    map = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    map = {};
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map));
  } catch (e) {
    /* volume ausente: só perde o mapa em restart */
  }
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  const first = String(xff).split(',')[0].trim();
  if (first) return first;
  return req.socket ? (req.socket.remoteAddress || '?') : '?';
}

function noteGuest(req, openId) {
  if (!openId) return;
  load();
  map[clientIp(req)] = { open_id: openId, t: nowSecs() };
  persist();
}

function lookupGuest(req) {
  load();
  // 1) guest registrado por este IP (vale 30 dias)
  const g = map[clientIp(req)];
  if (g && g.open_id && nowSecs() - (g.t || 0) < 86400 * 30) return g.open_id;
  // 2) ultimo guest visto em qualquer IP (fallback estavel)
  let best = null;
  let bestT = -1;
  for (const k of Object.keys(map)) {
    const v = map[k] || {};
    if ((v.t || 0) > bestT) {
      bestT = v.t || 0;
      best = v.open_id;
    }
  }
  return best || null;
}

module.exports = { noteGuest, lookupGuest, clientIp };
