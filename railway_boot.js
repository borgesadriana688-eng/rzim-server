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

  // diagnostico: grava TODAS as requisicoes p/ ver o que o cliente pede
  const reqLog = [];
  app.use((req, res, next) => {
    const e = { t: new Date().toISOString(), m: req.method, p: req.originalUrl,
                ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip, s: 0 };
    reqLog.push(e);
    if (reqLog.length > 1000) reqLog.shift();
    res.on('finish', () => { e.s = res.statusCode; });
    next();
  });
  app.get('/__requests', (req, res) => res.json(reqLog.slice(-400)));

  const express = require('express');
  // Cliente 1.27 manda os endpoints de protocolo (rota de um segmento,
  // ex.: /PlatformLogin) como application/x-www-form-urlencoded com o
  // protobuf percent-encoded. Estes parsers globais NAO podem consumir o
  // stream desses POSTs, senao o router de protocolo ve corpo vazio.
  const isProtoPost = (req) =>
    req.method === 'POST' && /^\/(v\d+\.\d+\/)?[^/]+$/.test(req.path || '/');
  app.use(express.json({ limit: '1mb', type: (req) => !isProtoPost(req) }));
  app.use(express.urlencoded({
    extended: false,
    limit: '1mb',
    type: (req) => !isProtoPost(req)
  }));

  // ---- login MONTROY local (lobby_local.js) — mesma tela do Termux ----
  // Montado ANTES de tudo: /dialog/oauth (pagina que o botao de login do
  // cliente abre), /api/captcha, /api/login, /api/register. Assim o cliente
  // 1.27 loga com usuario/senha MONTROY direto na nuvem, sem Termux.
  app.use('/', require('./src/routes/lobby_local'));

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
  const versionRoutes = require('./src/routes/version');
  app.use('/', guestRoutes);
  // /vver.php na RAIZ: o cliente 1.27 (2019) pede esse caminho (nao /ver.php)
  // com ?version=<versao do proprio cliente>. Responde espelhando a versao dele
  // -> cliente acha que ja esta atualizado e nao tenta baixar nada.
  app.get(['/vver.php', '/v127/vver.php', '/v143/vver.php', '/live/vver.php'], (req, res) => {
    const v = (req.query.version || '1.27.0').trim();
    const host = 'https://' + (req.headers.host || 'rzim-cloud.onrender.com') + '/';
    res.json({
      appstore_url: '',
      billboard_msg: 'Bem-vindo ao servidor privado RZIM',
      cdn_url: host + 'cdn/',
      client_ip: (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip,
      code: 0,
      country_code: 'BR',
      force_to_restart_app: false,
      gdpr_version: 2,
      is_firewall_open: false,
      is_review_server: false,
      is_server_open: true,
      maintenance_announcement: '',
      maintenance_region: '',
      remote_option_version: v,
      remote_version: v,
      server_url: host
    });
  });

  // ---- TELEMETRIA: registra as ultimas 300 requests p/ debug do cliente 1.27 ----
  const hits = [];
  app.use((req, res, next) => {
    hits.push({ t: new Date().toISOString(), m: req.method, p: req.url, ip: (req.headers['x-forwarded-for']||'').split(',')[0] });
    if (hits.length > 300) hits.shift();
    next();
  });
  app.get('/hits', (req, res) => res.json({ now: new Date().toISOString(), total: hits.length, hits }));

  app.use('/cdn', require('./src/routes/cdn'));

  app.use('/live', versionRoutes);
  // clientes antigos direto pela URL: /v143 (MID5) e /v127 (FF2019)
  app.use('/v143', versionRoutes.create('1.43.0'));
  app.use('/v127', versionRoutes.create('1.27.0'));
  app.use('/', createProtocolRouter({ filter: () => true }));
  app.use('/v143', createProtocolRouter({ filter: () => true }));
  app.use('/v127', createProtocolRouter({ filter: () => true }));
  app.use('/api', require('./src/routes/index'));

  finalizeApp(app, 'combined');


  // ---- keep-alive mutuo (Render free dorme apos 15min sem trafego) ----
  // Ao acordar (qualquer request do jogo), acorda os irmaos; e a cada 10 min
  // mantem todos quentes enquanto qualquer um estiver de pe.
  const KA = (process.env.KEEPALIVE_TARGETS ||
    'https://montro.onrender.com/|https://rzim-lobby143.onrender.com/')
    .split('|').map(s => s.trim()).filter(Boolean);
  const httpsMod = require('https');
  const kaPing = () => {
    for (const u of KA) {
      try {
        const r = httpsMod.get(u, { timeout: 120000 }, res => {
          res.resume();
          console.log('[keepalive] ' + u + ' -> ' + res.statusCode);
        });
        r.on('error', e => console.log('[keepalive] ' + u + ' erro: ' + e.message));
        r.on('timeout', () => r.destroy());
      } catch (e) {}
    }
  };
  setTimeout(kaPing, 5000);
  setInterval(kaPing, 10 * 60 * 1000);

  const port = process.env.PORT || config.ports.main || 3002;
  startServer(app, port, 'combined');
}

main().catch((err) => {
  console.error('[boot] falha ao iniciar:', err);
  process.exit(1);
});
