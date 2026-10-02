'use strict';

/**
 * Rota de debug do APK instrumentado: o patch RzimLog (smali) faz POST
 * aqui com cada log do SDK e das mensagens enviadas ao motor Unity.
 * Só loga no console (Railway), não guarda nada.
 */

const express = require('express');
const router = express.Router();

function bodyOf(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return {};
}

router.post('/sdkdebug', (req, res) => {
  const b = bodyOf(req);
  const tag = String(b.tag || '').slice(0, 64);
  const msg = String(b.msg || '').slice(0, 2000);
  // linha unica e facil de filtrar nos logs da Railway
  console.log('[SDKDBG] ' + tag + ' | ' + msg);
  res.json({ ok: true });
});

router.get('/sdkdebug', (req, res) => res.json({ ok: true }));

module.exports = router;
