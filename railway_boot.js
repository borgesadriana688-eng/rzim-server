'use strict';

// Boot único do Railway: sobe, NUMA porta só, o jogo (combined, do ZIP) e o
// sistema de login Discord do ZIP (auth/login-server + auth/connect-server).
//
// Nenhum arquivo do ZIP é alterado — este arquivo apenas monta os apps do ZIP
// num único processo, porque o Railway free roda um serviço só (no original os
// auth services eram containers separados atrás de Traefik, cada um num domínio).
//
// Os apps do auth têm 404 próprio (engolem qualquer requisição), então cada um
// só recebe os caminhos que são dele — as rotas do jogo (ZIP) casam primeiro:
//   1. guest + live + protocolo + /api (ZIP, mesma ordem do combined.js)
//   2. login-server (ZIP): /dialog/oauth (página que o botão "Facebook" abre,
//      com login via Discord), /pair/status, callback do Discord
//   3. connect-server (ZIP): /oauth/token/facebook/exchange + rotas graph
//      do SDK do Facebook que o jogo não cobre
//   4. /health + 404 (finalizeApp do ZIP)
//
// Sem DATABASE_URL ou DISCORD_CLIENT_ID, sobe no modo jogo puro (combined).

require('dotenv').config();

const config = require('./config/default');
const { createBaseApp, finalizeApp } = require('./src/apps/base');
const { startServer } = require('./src/servers/_start');
const guestRoutes = require('./src/routes/guest');
const createProtocolRouter = require('./src/protocol/router');

// Caminhos atendidos pelo login-server / connect-server do ZIP (apps com 404
// próprio, então o roteamento é por caminho, pra não sombrear as rotas do jogo).
const loginPaths = [
  /^\/(v[\d.]+\/)?dialog\//,        // /dialog/oauth, /v9.0/dialog/oauth
  /^\/pair\//,                      // /pair/status
  /^\/(terms|privacy|health)$/,
  /^\/$/,
];
const connectPaths = [
  /^\/oauth\/token\/facebook\/exchange$/,
  /^\/(v[\d.]+\/)?me\/(permissions|friends)/,
  /^\/(v[\d.]+\/)?debug_token$/,
  /^\/v[\d.]+\/\d+(\/activities)?$/,
];

async function main() {
  const app = createBaseApp();

  const express = require('express');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---- auth do ZIP (login Discord) ----
  const wantsAuth = !!(process.env.DATABASE_URL && process.env.DISCORD_CLIENT_ID);
  if (wantsAuth) {
    const shared = require('./auth/shared/src');
    const handle = await shared.store.connect();
    await shared.store.ensureSchema(handle);
    const guests = shared.createGuestsRepo(handle);
    const accounts = shared.createAccountsRepo(handle);
    const pairings = shared.createPairingsRepo(handle);

    const loginApp = require('./auth/login-server/src/app')({ guests, accounts, pairings });
    const connectApp = require('./auth/connect-server/src/app')({ guests });
    const callbackPath = new RegExp(
      '^' + String(shared.config.DISCORD_CALLBACK_PATH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
    );

    app.use((req, res, next) => {
      if (callbackPath.test(req.path)) return loginApp(req, res, next);
      next();
    });
    app.use((req, res, next) => {
      if (loginPaths.some((re) => re.test(req.path))) return loginApp(req, res, next);
      next();
    });
    app.use((req, res, next) => {
      if (connectPaths.some((re) => re.test(req.path))) return connectApp(req, res, next);
      next();
    });
    console.log('[boot] auth (login-server + connect-server) montado');
  } else {
    console.log('[boot] auth desativado (sem DATABASE_URL/DISCORD_CLIENT_ID) — modo jogo puro');
  }

  // ---- jogo do ZIP (mesma ordem do src/servers/combined.js) ----
  app.use('/', guestRoutes);
  app.use('/live', require('./src/routes/version'));
  app.use('/', createProtocolRouter({ filter: () => true }));
  app.use('/api', require('./src/routes/index'));

  finalizeApp(app, 'combined');

  const port = process.env.PORT || config.ports.main || 3002;
  startServer(app, port, 'combined');
}

main().catch((err) => {
  console.error('[boot] falha ao iniciar:', err);
  process.exit(1);
});
