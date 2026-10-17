const fs = require('fs');
const path = require('path');
const express = require('express');

const logger = require('../logger');
const { lookup } = require('./protos');
const { encrypt, decrypt, BODY_ENCODING } = require('./aes');
const replayGuard = require('./replayGuard');
const { getRepo } = require('../db/repo');
const { getBus } = require('../bus/instance');

// Endpoints that DON'T require a Bearer token (login/registration/handshake).
// Everything else must present a valid token resolvable via player.getByToken.
const PUBLIC_ENDPOINTS = new Set([
  'MajorLogin',
  'MajorRegister',
  'Login',
  'PlatformLogin',
  'PlatformRegister',
  'TestConnection',
  'GetServerInfo'
]);

// LoginGet* (e.g. LoginGetSplash) are part of the pre-auth handshake.
function isPublicEndpoint(cmd) {
  return PUBLIC_ENDPOINTS.has(cmd) || cmd.startsWith('LoginGet');
}

// Endpoint table: array of { caller, cmd, cmd_hex, reqType, resType, endpoint }.
const ENDPOINT_MAP = require('../../protocol/endpoint_map.json');

// endpoint name -> map entry (first occurrence wins; later duplicates ignored).
const endpointIndex = new Map();
for (const entry of ENDPOINT_MAP) {
  if (entry && entry.endpoint && !endpointIndex.has(entry.endpoint)) {
    endpointIndex.set(entry.endpoint, entry);
  }
}

// endpoint name -> { fn, reqType?, resType? }. reqType/resType here override the
// endpoint_map (needed for endpoints that are not present in the map at all).
const handlers = new Map();

/**
 * Register a handler for an endpoint.
 *
 * @param {string} endpoint   URL path / endpoint name (e.g. "MajorLogin").
 * @param {(reqObj: object, ctx: object) => (object|Promise<object>)} fn
 *        Handler. Receives the decoded request as a plain object and a ctx,
 *        returns the response as a plain object (encoded against resType).
 * @param {{reqType?: string, resType?: string}} [meta]
 *        Optional type overrides for endpoints missing from endpoint_map.json.
 */
function registerHandler(endpoint, fn, meta = {}) {
  if (typeof fn !== 'function') {
    throw new TypeError(`registerHandler(${endpoint}): fn must be a function`);
  }
  handlers.set(endpoint, { fn, reqType: meta.reqType, resType: meta.resType });
}

/**
 * Auto-load every module in src/handlers/. One file per real endpoint, each
 * exporting the endpoint contract:
 *
 *   module.exports = {
 *     endpoint: 'MajorLogin',
 *     reqType: 'LoginReq', resType: 'MajorLoginRes',
 *     handler: (reqObj, ctx) => resObj   // may be async; may use ctx.res directly
 *   };
 *
 * For backwards compatibility the loader also accepts:
 *   - { endpoints: [ { endpoint, handler, reqType?, resType? }, ... ] }
 *   - a function (registerHandler) => { ... }  (legacy self-registering module)
 *   - { register(registerHandler) { ... } }    (legacy self-registering module)
 *
 * Files whose name starts with '_' (e.g. _shared.js, _stubs.js) are NOT endpoint
 * modules and are skipped here. AFTER all real handlers are loaded, _stubs.js is
 * invoked LAST to register a single generic stub for every remaining endpoint in
 * endpoint_map.json — so real handlers always win.
 */
function loadHandlers() {
  const dir = path.join(__dirname, '..', 'handlers');
  if (!fs.existsSync(dir)) return;

  // Deterministic order (fs.readdirSync order is not stable across OSes).
  // Skip non-endpoint modules (names starting with '_').
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .sort((a, b) => a.localeCompare(b));

  const registerEntry = (entry, file) => {
    if (entry && typeof entry.endpoint === 'string' && typeof entry.handler === 'function') {
      registerHandler(entry.endpoint, entry.handler, {
        reqType: entry.reqType,
        resType: entry.resType
      });
      return true;
    }
    return false;
  };

  for (const file of files) {
    const mod = require(path.join(dir, file));
    if (registerEntry(mod, file)) {
      // single-endpoint module ({ endpoint, handler, ... })
    } else if (mod && Array.isArray(mod.endpoints)) {
      // multi-endpoint module ({ endpoints: [...] })
      for (const entry of mod.endpoints) registerEntry(entry, file);
    } else if (typeof mod === 'function') {
      mod(registerHandler); // legacy self-registering module
    } else if (mod && typeof mod.register === 'function') {
      mod.register(registerHandler); // legacy self-registering module
    } else {
      logger.warn(`[router] handler module ${file} exports nothing callable`);
    }
  }

  // Last: register the single generic stub for every endpoint in endpoint_map
  // that no real handler claimed above.
  require('../handlers/_stubs').register(registerHandler, handlers);
}

// --- transport helpers -----------------------------------------------------

// Quantos campos uteis o ReqType decodifica deste buffer (para desempatar
// corpo aberto vs AES). Buffer que nao decodifica -> 0.
function scoreDecode(buf, reqTypeName) {
  try {
    const ReqType = lookup(reqTypeName);
    if (!ReqType) return 0;
    const msg = ReqType.decode(buf);
    const obj = ReqType.toObject(msg, { longs: Number, enums: Number, defaults: true });
    let score = 0;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && v.length) score++;
      else if (typeof v === 'number' && v) score++;
      else if (Buffer.isBuffer(v) && v.length) score++;
      else if (Array.isArray(v) && v.length) score++;
      else if (v !== null && typeof v === 'object' && Object.keys(v).length) score++;
    }
    return score;
  } catch (e) {
    return 0;
  }
}

// Walk top-level protobuf fields: retorna true se o buffer inteiro parses como
// uma sequencia valida de campos (tag varint + wire type 0/1/2/5) consumindo
// exatamente o fim do buffer. Corpos AES (aleatorios) nao passam na pratica.
function isValidProtobufBody(buf) {
  let i = 0;
  const len = buf.length;
  let fields = 0;
  while (i < len && fields < 64) {
    // tag (varint)
    let tag = 0, shift = 0, b;
    do {
      if (i >= len) return false;
      b = buf[i++];
      if (shift > 28) return false;
      tag |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const wireType = tag & 7;
    const fieldNum = tag >>> 3;
    if (fieldNum === 0) return false;
    if (wireType === 3 || wireType === 4) return false; // grupos deprecated
    if (wireType > 5) return false;
    if (wireType === 0) {
      let vshift = 0;
      let vb;
      do {
        if (i >= len) return false;
        vb = buf[i++];
        vshift += 7;
        if (vshift > 63) return false;
      } while (vb & 0x80);
    } else if (wireType === 1) {
      i += 8;
      if (i > len) return false;
    } else if (wireType === 5) {
      i += 4;
      if (i > len) return false;
    } else if (wireType === 2) {
      let flen = 0, fshift = 0, fb;
      do {
        if (i >= len) return false;
        fb = buf[i++];
        flen |= (fb & 0x7f) << fshift;
        fshift += 7;
        if (fshift > 28) return false;
      } while (fb & 0x80);
      if (i + flen > len) return false;
      i += flen;
    }
    fields++;
  }
  return i === len && fields > 0;
}

function bodyToCipher(body) {
  // express.raw gives us a Buffer; base64 mode means that Buffer is base64 text.
  if (BODY_ENCODING === 'base64') {
    return Buffer.from(body.toString('utf8').trim(), 'base64');
  }
  return body;
}

function cipherToBody(cipher) {
  if (BODY_ENCODING === 'base64') {
    return Buffer.from(cipher.toString('base64'), 'utf8');
  }
  return cipher;
}

// AES-encode `resObj` against `resTypeName` and write the transport response.
function sendEncoded(res, resTypeName, resObj) {
  const ResType = lookup(resTypeName) || lookup('Empty');
  const message = ResType.fromObject(resObj || {});
  const encoded = ResType.encode(message).finish();
  res.status(200).type('application/octet-stream').send(encoded);
}

// Plaintext (non-protobuf) endpoints. Some telemetry endpoints (e.g. LogEvent)
// send plain JSON, NOT AES(protobuf). These must bypass decrypt/decode and are
// acked with an empty 200 (matching the reference server).
const PLAINTEXT_ENDPOINTS = new Set(['LogEvent', 'NetworkLogEvent']);

// --- router ----------------------------------------------------------------

function createProtocolRouter({ filter } = {}) {
  const router = express.Router();

  router.post(
    '/:cmd',
    express.raw({ type: () => true, limit: '16mb' }),
    async (req, res, next) => {
      const cmd = req.params.cmd;

      // Command-level partition: this router instance only owns some endpoints
      // (login server owns AUTH_COMMANDS, main server owns the rest). Anything it
      // doesn't own falls through so a sibling route / 404 handles it.
      if (filter && !filter(cmd)) return next();

      const entry = endpointIndex.get(cmd);
    const handler = handlers.get(cmd);

    // Unknown endpoint with no handler -> let other routes / 404 handle it
    // (plaintext endpoints like LogEvent may have no protobuf entry/handler).
    if (!entry && !handler && !PLAINTEXT_ENDPOINTS.has(cmd)) return next();

    // Force a fresh connection per request. The game's HTTP client reuses
    // keep-alive connections; combined with Node's 5s keepAliveTimeout (and a
    // pooled connection going stale after a server restart) the reuse races with
    // the server closing the socket, which the client surfaces as an
    // intermittent "IO: Stream closed" / network error. Responding with
    // `Connection: close` makes every request its own connection -> no reuse,
    // no race. Covers every response path below (404, auth-empty, encoded, error).
    res.setHeader('Connection', 'close');

    // Plaintext endpoints (e.g. LogEvent): the client sends plain JSON, NOT
    // AES(protobuf). Do NOT decrypt/decode — log it and ack with an empty 200.
    if (PLAINTEXT_ENDPOINTS.has(cmd)) {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      let json;
      try { json = raw ? JSON.parse(raw) : {}; } catch (e) { json = { _raw: raw }; }
      req.decodedRequest = json;
      req.endpointName = cmd;
      logger.info(`[router] ${cmd} (plaintext JSON) -> 200 ack`);
      return res.status(200).type('application/octet-stream').end();
    }

    // Replay guard (opt-in): drop a byte-identical resend of a recent body to the
    // same endpoint — a captured-and-replayed packet. OFF by default; see
    // config.security.replay and src/protocol/replayGuard.js.
    if (replayGuard.enabled && Buffer.isBuffer(req.body) && req.body.length &&
        replayGuard.isReplay(cmd, req.body)) {
      logger.warn(`[router] ${cmd}: replay dropped (duplicate body within window)`);
      return res.status(409).type('text/plain').end();
    }

    const reqTypeName = (handler && handler.reqType) || (entry && entry.reqType);
    const resTypeName =
      (handler && handler.resType) || (entry && entry.resType) || 'Empty';

    try {
      // 1) Decode the request (if any).
      let reqObj = {};
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let plain = Buffer.alloc(0);

      if (rawBody.length > 0) {
        const cipher = bodyToCipher(rawBody);
        // Cliente 1.27 (Free Fire 2019) envia protobuf ABERTO; o 1.43 envia
        // AES-128-CBC (mesmo processo serve os dois servicos). Decidir pela
        // estrutura: so um walk completo e valido da arvore de campos fecha
        // no byte exato; ciphertext AES (alta entropia) quase nunca fecha.
        let dec = null;
        try { dec = decrypt(cipher); } catch (e) { dec = null; }
        const rawValid = isValidProtobufBody(cipher);
        const decValid = dec ? isValidProtobufBody(dec) : false;
        if (decValid && !rawValid) {
          plain = dec; // 1.43: envelope AES com protobuf real dentro
        } else if (rawValid && !decValid) {
          plain = cipher; // 1.27: protobuf aberto
        } else if (rawValid && decValid) {
          // ambiguo: o que decodifica com mais campos uteis ganha
          plain = (scoreDecode(cipher, reqTypeName) >= scoreDecode(dec, reqTypeName))
            ? cipher : dec;
        } else {
          plain = cipher; // nenhum fecha: nao era AES -> usa como veio
        }
        const ReqType = lookup(reqTypeName);
        if (ReqType) {
          const msg = ReqType.decode(plain);
          reqObj = ReqType.toObject(msg, {
            longs: Number,
            enums: Number,
            bytes: Buffer,
            defaults: true
          });
        } else {
          logger.warn(`[router] ${cmd}: unknown reqType '${reqTypeName}' -> raw request ignored`);
        }
      } else {
        logger.warn(`[router] ${cmd}: empty request body -> raw request ignored`);
      }

      logger.info(`[router] current request: reqType=${reqTypeName}, resType=${resTypeName}, endpoint=${cmd}`);

      // Expose the decoded request so the request logger can print it as JSON
      // (instead of the raw AES'd Buffer). reqTypeName helps interpret it.
      req.decodedRequest = reqObj;
      req.reqTypeName = reqTypeName;
      req.endpointName = cmd;

      // 2) Bearer-token auth for non-public endpoints.
      let account = null;
      if (!isPublicEndpoint(cmd)) {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : '';
        account = token ? await getRepo().getByToken(token) : null;
        if (!account) {
          // No / invalid token on an authed endpoint: respond benignly with a
          // default-constructed resType (never crash the client).
          logger.warn(`[router] ${cmd}: missing/invalid token -> empty response`);
          return sendEncoded(res, resTypeName, {});
        }
      }

      // 3) Build the response object (handler or generic default-constructed).
      let dirty = false;
      const ctx = {
        endpoint: cmd,
        entry,
        reqTypeName,
        resTypeName,
        rawRequest: plain,
        req,
        res,
        logger,
        // Authenticated player document (null on public endpoints), plus a
        // convenience persist hook. See the porting contract in src/handlers.
        account,
        // Mark the account for persistence; the router does the single awaited
        // save AFTER the handler returns, so handlers don't each await a write.
        savePlayer() {
          dirty = true;
          return account;
        }
      };

      let resObj;
      if (handler) {
        resObj = await handler.fn(reqObj, ctx);
      }
      // Persist the authenticated account if the handler mutated it, then tell the TCP
      // gateway (a different process) so it refreshes its cached snapshot — the
      // matchmaker builds the prepare_token from that snapshot, so this keeps a match's
      // cosmetics in sync with lobby changes. Best-effort PubSub; never blocks.
      if (dirty && account) {
        await getRepo().save(account);
        try {
          const bus = getBus();
          if (bus) {
            bus.publishPS('player.updated', 'PlayerUpdated', { account_id: Number(account.uid) })
              .catch((e) => logger.warn(`[router] player.updated publish: ${e.message}`));
          }
        } catch (e) { logger.warn(`[router] player.updated: ${e.message}`); }
      }
      // A handler may take full control of the transport (e.g. MajorLogin sends a
      // 404 so the client opens the register screen). If it already responded,
      // don't try to encode/send again.
      if (res.headersSent) return;
      if (resObj === undefined || resObj === null) resObj = {};
      req.decodedResponse = resObj;

      // 4) Encode + transport wrap (responses are plaintext protobuf).
      return sendEncoded(res, resTypeName, resObj);
    } catch (err) {
      logger.error(`[router] ${cmd} failed: ${err.stack || err.message}`);
      next(err);
    }
  }
  );

  return router;
}

// Load handler modules now so they are registered before any router is built.
loadHandlers();

module.exports = createProtocolRouter;
module.exports.createProtocolRouter = createProtocolRouter;
module.exports.registerHandler = registerHandler;
module.exports.loadHandlers = loadHandlers;
module.exports.handlers = handlers;
module.exports.endpointIndex = endpointIndex;
