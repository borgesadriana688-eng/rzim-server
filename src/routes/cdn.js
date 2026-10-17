'use strict';

// Emulacao do CDN de hot-update (akamaihd / ABHotUpdates) para os clientes
// antigos. O cliente 2019 (1.27) pede:
//   <cdn_url>/android/1.27.1/fileinfo      -> lista CSV de arquivos
//   <cdn_url>/android/1.27.1/versioninfo   -> versao + contador
// Se devolvermos EXATAMENTE o que o cliente ja tem localmente (extraido do
// proprio APK em data/cdn/<versao>/), ele conclui que esta atualizado e nao
// baixa nada -> some o "Falha no download".

const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data', 'cdn');

const router = express.Router();

router.get('/android/:version/:file(fileinfo|versioninfo)', (req, res) => {
    const { version, file } = req.params;
    const fp = path.join(DATA, version, file);
    fs.readFile(fp, (err, data) => {
        if (err || !data.length) {
            // versao sem manifest no nosso servidor: devolve o do 1.27.1
            try {
                data = fs.readFileSync(path.join(DATA, '1.27.1', file));
            } catch (e) {
                data = Buffer.from('1.27.1\r\n17');
            }
        }
        res.set('Content-Type', 'application/octet-stream');
        res.send(data);
    });
});

// Servir os arquivos reais de hot-update quando o cliente pede (ex. lochotfix
// de uma instalacao antiga que nao bate com o fileinfo atual). O arquivo fica
// em data/cdn/<versao>/files/<caminho-do-fileinfo>.
router.get('/android/:version/*', (req, res) => {
    const { version } = req.params;
    const rest = req.params[0];
    if (rest.includes('..')) return res.status(400).end();
    const fp = path.join(DATA, version, 'files', rest);
    fs.readFile(fp, (err, data) => {
        if (err) {
            console.log(`[CDN] arquivo pedido nao temos: ${version}/${rest}`);
            return res.status(404).end();
        }
        res.set('Content-Type', 'application/octet-stream');
        res.send(data);
    });
});

module.exports = router;
