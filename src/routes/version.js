const express = require('express');
const config = require('../../config/default');

// Cada versao do cliente tem sua rota (/ver.php na raiz e /live para o 1.70,
// /v143 para o MID5, /v127 para o FreeFire 2019 Private). A fabrica cria um
// router por versao; o export padrao mantem o comportamento antigo (usa
// GAME_VERSION do ambiente) para os outros apps que montam em /live.

function loginServerUrl(req) {
    const loginDomain = (config.domains && config.domains.login) || '';
    if (loginDomain) {
        const base = loginDomain.includes('://') ? loginDomain : 'https://' + loginDomain;
        return base.endsWith('/') ? base : base + '/';
    }
    // Termux (sem HTTPS): devolve http com o Host da propria requisicao
    const host = (req && req.headers && req.headers.host) || '';
    if (host) return 'http://' + host + '/';
    return 'http://127.0.0.1:' + (config.ports && config.ports.login || 18000) + '/';
}

function createVersionRouter(versionOverride) {
    const router = express.Router();
    const version = versionOverride || process.env.GAME_VERSION || config.version || '1.70.0';

    router.get('/ver.php', (req, res) => {
        const requestIp = req.headers['x-forwarded-for'] || req.ip;
        res.json({
            appstore_url: 'https://play.google.com/store/apps/details?id=com.dts.freefireth',
            billboard_msg: '',
            cdn_url: "https://dl.cdn.freefiremobile.com/live/ABHotUpdates/",
            client_ip: requestIp,
            code: 0,
            country_code: 'BR',
            force_to_restart_app: false,
            gdpr_version: 2,
            is_firewall_open: false,
            is_review_server: false,
            is_server_open: true,
            maintenance_announcement: '',
            maintenance_region: '',
            // Clientes antigos (1.27, pacote 2019): string simples igual a remote_version
            // faz o cliente pular a checagem de recursos opcionais (padrao do lobby antigo
            // que funcionava). O string longo da 1.70 faz o 1.27 tentar baixar do CDN
            // oficial -> "Falha no download".
            remote_option_version: version.startsWith('1.27') ? version : 'optionalclothres:282|optionalmap1res:194|optionalmap2res:36|optionalmap4res:19|optionalmapres:17|optionalpetres:17|optionalvoiceres:147|optionalwerewolves:48',
            remote_version: version,
            server_url: loginServerUrl(req)
        });
    });

    return router;
}

module.exports = createVersionRouter();   // compat: router com GAME_VERSION
module.exports.create = createVersionRouter;
