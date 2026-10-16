'use strict';

// Mini servidor roteador (servico "montro" no Render).
// O APK do Free Fire 1.27 tem gravado um endereco curto
// (https://montro.onrender.com) que precisa caber no lugar da URL antiga do
// pack (http://190.115.198.51:18000, 27 bytes).
//
// Rotas:
//   - dialog/login (tela de conta MONTROY) -> 302 pro rzim-lobby143 (HTML)
//   - todo o resto (SDK: /app/info/get, oauth/*, heartbeat, /me...) ->
//     PROXY transparente pro rzim-cloud (mantem metodo e corpo; um 302
//     converteria POST em GET e derrubaria o corpo, quebrando o token).

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const LOBBY = (process.env.LOBBY_TARGET || 'https://rzim-lobby143.onrender.com').replace(/\/+$/, '');
const CLOUD = (process.env.CLOUD_TARGET || 'https://rzim-cloud.onrender.com').replace(/\/+$/, '');
const cloudUrl = new URL(CLOUD);

// caminhos de tela de login (dialog oauth / login.php) vao pro lobby
function ehDialog(url) {
    const p = url.split('?')[0].replace(/\/+$/, '');
    return /\/dialog\/oauth$/.test(p) || /\/login\.php$/.test(p) || /^\/(v[0-9.]+\/)?(dialog|login)/.test(p);
}

const server = http.createServer((req, res) => {
    // health check do Render: responde 200 direto
    const sohRaiz = req.url.split('?')[0].replace(/\/+$/, '');
    if (sohRaiz === '' || sohRaiz === '/healthz' || sohRaiz === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('montroy ok');
    }
    if (ehDialog(req.url)) {
        res.writeHead(302, { Location: LOBBY + req.url, 'Cache-Control': 'no-store' });
        return res.end();
    }
    // proxy transparente pro rzim-cloud
    const headers = Object.assign({}, req.headers);
    headers.host = cloudUrl.host;
    const opts = {
        hostname: cloudUrl.hostname,
        port: 443,
        path: req.url,
        method: req.method,
        headers: headers,
        timeout: 60000
    };
    const up = https.request(opts, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (err) => {
        console.error('proxy erro:', err.message, req.url);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1000, error: 'proxy_unavailable' }));
    });
    req.pipe(up);
});

server.listen(PORT, () => {
    console.log('montro: dialog->' + LOBBY + ' | proxy->' + CLOUD + ' | porta ' + PORT);
});
