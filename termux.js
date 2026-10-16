'use strict';

// termux.js — servidor RZIM FF 1.70 completo rodando NO CELULAR (Termux).
//
// Diferente do combined.js (uma porta só, feito pra Railway), aqui o servidor
// escuta nas MESMAS portas que o cliente já conhece da ponte antiga:
//   HTTP: 18000, 18001, 5008  (login/lobby/live/SDK — mesmo app nas três)
//   TCP : 18002               (gateway de notificação/salas do jogo)
//   UDP : 10100               (servidor de partida em Go — binário à parte)
//
// Como usar:
//   pkg install nodejs redis -y
//   npm install --ignore-scripts
//   redis-server --daemonize yes
//   termux-wake-lock
//   node termux.js
// E em outra sessão do Termux:
//   chmod +x ~/ms-arm64 && ~/ms-arm64

require('dotenv').config();
const http = require('http');
const express = require('express');
const logger = require('./src/logger');
const config = require('./config/default');
const { createBaseApp, finalizeApp } = require('./src/apps/base');
const guestRoutes = require('./src/routes/guest');
const createProtocolRouter = require('./src/protocol/router');
const { createGateway } = require('./src/tcp/gateway');

// --- HTTP: o mesmo app do combined.js nas portas do cliente ----------------
const app = createBaseApp();

// Body parsers das rotas do SDK (form/json). O protocolo do jogo manda
// application/octet-stream, então os parsers pulam.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 1) SDK: guest automático + app/info + heartbeat + graph mínimo
app.use('/', guestRoutes);

// 2) live: /live/ver.php (aponta pro login = este mesmo host)
// 3) live/versao: o jogo pede /ver.php NA RAIZ (o lobby antigo respondia lá);
//    montamos na raiz E em /live pra cobrir os dois caminhos.
const versionRoutes = require('./src/routes/version');
app.use('/', versionRoutes);
app.use('/cdn', require('./src/routes/cdn'));
app.use('/live', versionRoutes);
// Todas as versoes de cliente ao mesmo tempo:
//   / e /live  -> 1.70 (padrao, ajustavel com GAME_VERSION)
//   /v143      -> 1.43 (MID5 Private)
//   /v127      -> 1.27 (FreeFire 2019 Private)
app.use('/v143', versionRoutes.create('1.43.0'));
app.use('/v127', versionRoutes.create('1.27.0'));

// 3) protocolo do jogo: TODOS os endpoints AES/protobuf (raiz + cada versao)
app.use('/', createProtocolRouter({ filter: () => true }));
app.use('/v143', createProtocolRouter({ filter: () => true }));
app.use('/v127', createProtocolRouter({ filter: () => true }));

// 4) /api genérico do main

// 5) telas de login do cliente 1.27 (webview): 302 pro lobby MONTROY no Render.
//    A WebView do Android segue redirects; as rotas de SDK (/app/info/get,
//    /oauth/*, /me) seguem servidas aqui mesmo, direto do Termux.
const LOBBY143 = (process.env.LOBBY143_TARGET || 'https://rzim-lobby143.onrender.com').replace(/\/+$/, '');
const ehDialogT = (p) => {
    const q = p.split('?')[0].replace(/\/+$/, '');
    return /\/dialog\/oauth$/.test(q) || /\/login\.php$/.test(q) || /^\/(v[0-9.]+\/)?(dialog|login)/.test(q);
};
app.use((req, res, next) => {
    if (ehDialogT(req.url)) return res.redirect(302, LOBBY143 + req.url);
    next();
});

app.use('/api', require('./src/routes/index'));

// Qualquer rota nao reconhecida chega aqui ANTES do 404 — deixa o log dizer
// exatamente o que o jogo pediu e a gente nao tem (diagnostico de missing route).
app.use((req, _res, next) => {
  logger.warn(`[termux] ROTA DESCONHECIDA: ${req.method} ${req.path}`);
  next();
});

finalizeApp(app, 'termux');

const HTTP_PORTS = (process.env.TERMUX_HTTP_PORTS || '18000,18001,5008')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);

for (const port of HTTP_PORTS) {
  const server = http.createServer(app);
  // mesmos timeouts do _start.js (evita o race de keep-alive no cliente)
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.listen(port, () => logger.info(`[termux] http na porta ${port}`));
}

// --- TCP: gateway de notificação/salas --------------------------------------
const TCP_PORT = Number(process.env.TCP_PORT || 18002);
const gateway = createGateway();
gateway.listen(TCP_PORT, () => logger.info(`[termux] gateway tcp na porta ${TCP_PORT}`));

// --- partida (UDP 10100) é o binário Go: ./ms-arm64 -------------------------

logger.info('[termux] servidor pronto. abre o jogo.');

function shutdown(signal) {
  logger.info(`[termux] ${signal} — desligando`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
