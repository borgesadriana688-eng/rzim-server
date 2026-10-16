'use strict';

// Mini servidor redirecionador (servico "montro" no Render).
// O APK do Free Fire 1.27 tem gravado um endereco curto
// (https://montro.onrender.com) que precisa caber no lugar da URL antiga do
// pack (http://190.115.198.51:18000, 27 bytes).
//
// Rotas:
//   - dialog/login (tela de conta MONTROY)  -> rzim-lobby143 (HTML da pagina)
//   - todo o resto (SDK: /app/info/get, oauth/*, heartbeat...) -> rzim-cloud
//     (que serve as respostas JSON do 1.27 e valida o token do lobby)
// NAO redirecionar tudo pro lobby: o lobby responde valores do 1.43 e o
// cliente 1.27 crasha na inicializacao quando recebe esse conteudo.

const http = require('http');

const PORT = process.env.PORT || 10000;
const LOBBY = (process.env.LOBBY_TARGET || 'https://rzim-lobby143.onrender.com').replace(/\/+$/, '');
const CLOUD = (process.env.CLOUD_TARGET || 'https://rzim-cloud.onrender.com').replace(/\/+$/, '');

// caminhos de tela de login (dialog oauth / login.php) vao pro lobby
function ehDialog(url) {
    const p = url.split('?')[0].replace(/\/+$/, '');
    return /\/dialog\/oauth$/.test(p) || /\/login\.php$/.test(p) || /^\/(v[0-9.]+\/)?(dialog|login)/.test(p);
}

const server = http.createServer((req, res) => {
    const destino = ehDialog(req.url) ? LOBBY : CLOUD;
    res.writeHead(302, { Location: destino + req.url, 'Cache-Control': 'no-store' });
    res.end();
});

server.listen(PORT, () => {
    console.log('montro: dialog->' + LOBBY + ' sdk->' + CLOUD + ' na porta ' + PORT);
});
