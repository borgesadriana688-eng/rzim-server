const express = require('express');
const router = express.Router();
const service = require('../services/exampleService');
const config = require('../../config/default');
// ver.php redirects the client to the LOGIN server next. Em produção com um
// domínio só (Railway), o login É este mesmo host — então sem LOGIN_DOMAIN
// usamos o Host da requisição com https (o Railway termina o TLS pra gente).
const loginDomain = (config.domains && config.domains.login) || '';
const version = process.env.GAME_VERSION || config.version || '1.70.0';

function loginServerUrl(req) {
    if (loginDomain) {
        const base = loginDomain.includes('://') ? loginDomain : 'https://' + loginDomain;
        return base.endsWith('/') ? base : base + '/';
    }
    const host = (req && req.headers && req.headers.host) || '';
    if (host) return 'https://' + host + '/';
    return 'http://127.0.0.1:' + config.ports.login + '/';
}

router.get('/ver.php', async (req, res) => {
    const requestIp = req.headers['x-forwarded-for'] || req.ip;
    data = {
        "appstore_url": "https://play.google.com/store/apps/details?id=com.dts.freefireth",
        "billboard_msg": "",
        "cdn_url": "https://dl.cdn.freefiremobile.com/live/ABHotUpdates/",
        "client_ip": requestIp,
        "code": 0,
        "country_code": "BR",
        "force_to_restart_app": false,
        "gdpr_version": 2,
        "is_firewall_open": false,
        "is_review_server": false,
        "is_server_open": true,
        "maintenance_announcement": "",
        "maintenance_region": "",
        "remote_option_version": "optionallocres:26|optionalclothres:282|optionalfullscreencgres:19|optionalludores:19|optionalmap1res:194|optionalmap2res:36|optionalmap4res:19|optionalmapres:17|optionalpetres:17|optionalrushb:38|optionalrushingpetsres:61|optionalvoiceres:147|optionalwerewolves:48",
        "remote_version": version,
        "server_url": loginServerUrl(req)
    }
    res.json(data);
});

module.exports = router;
