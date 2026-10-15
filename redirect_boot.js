'use strict';

// Mini servidor redirecionador (servico "montro" no Render).
// O APK do Free Fire 1.27 tem gravado um endereco curto
// (https://montro.onrender.com) que precisa caber no lugar da URL antiga do
// pack (http://190.115.198.51:18000, 27 bytes). Toda requisicao que chegar
// aqui e redirecionada para o lobby oficial (rzim-lobby143), que serve a
// pagina de login MONTROY (entrar / criar conta) em /dialog/oauth e responde
// /app/info/get. Preserva caminho e query string.

const http = require('http');

const PORT = process.env.PORT || 10000;
const TARGET = (process.env.REDIRECT_TARGET || 'https://rzim-lobby143.onrender.com').replace(/\/+$/, '');

const server = http.createServer((req, res) => {
    const alvo = TARGET + req.url;
    res.writeHead(302, { Location: alvo, 'Cache-Control': 'no-store' });
    res.end();
});

server.listen(PORT, () => {
    console.log('montro redirect -> ' + TARGET + ' na porta ' + PORT);
});
