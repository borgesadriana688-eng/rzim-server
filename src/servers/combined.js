'use strict';

/**
 * Servidor COMBINADO — tudo do lobby em UMA porta (feito pra Railway).
 *
 * Monta no mesmo domínio:
 *   1. Rotas do SDK (guest automático) — src/routes/guest.js
 *   2. live (/live/ver.php) — entrega ao cliente a URL do login (este mesmo host)
 *   3. Router de protocolo AES/protobuf — TODOS os comandos (login + main)
 *   4. /api (health)
 *
 * O cliente do jogo só precisa apontar pra este domínio; cada fase
 * (ver.php -> MajorLogin -> GetLoginData) entrega o próximo endereço,
 * e como é tudo o mesmo host, funciona com um domínio só.
 */

require('dotenv').config();
const express = require('express');
const config = require('../../config/default');
const { createBaseApp, finalizeApp } = require('../apps/base');
const { startServer } = require('./_start');
const guestRoutes = require('../routes/guest');
const createProtocolRouter = require('../protocol/router');

const app = createBaseApp();

// Body parsers das rotas do SDK (form/json). Não interferem no protocolo do
// jogo, porque o cliente manda application/octet-stream e os parsers pulam.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 1) SDK: guest automático + app/info + heartbeat + graph mínimo
app.use('/', guestRoutes);

// 2) live: /live/ver.php (aponta pro login = este mesmo host)
app.use('/live', require('../routes/version'));

// 3) protocolo do jogo: TODOS os endpoints AES/protobuf
app.use('/', createProtocolRouter({ filter: () => true }));

// 4) /api genérico do main
app.use('/api', require('../routes/index'));

finalizeApp(app, 'combined');

const port = process.env.PORT || config.ports.main || 3002;
startServer(app, port, 'combined');
