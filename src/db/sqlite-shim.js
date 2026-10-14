'use strict';

// Fallback do better-sqlite3 sem compilação nativa — feito para rodar no
// Termux/Android, onde o better-sqlite3 não compila. Usa o node:sqlite
// nativo (Node >= 22.5, sem dependências extras).
//
// Suporta o subconjunto que o servidor usa (src/db/accounts.js, player.js):
//   new Database(path) / .pragma(str) / .exec(str)
//   .prepare(sql) -> .run(...args|obj) / .get(...) / .all(...)
//   parâmetros posicionais (?) e nomeados (@x) com chaves SEM prefixo,
//   exatamente como o better-sqlite3 aceita.

const { DatabaseSync } = require('node:sqlite');

const NAMED_RE = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;

// Mapeia chaves sem prefixo ({open_id: 1}) para a forma com prefixo
// (@open_id), que é o que o node:sqlite espera para o SQL dado.
function bindParams(sql, args) {
  if (args.length === 0) return [];
  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === 'object' && !Array.isArray(first) && !Buffer.isBuffer(first)) {
    const names = new Set();
    let m;
    NAMED_RE.lastIndex = 0;
    while ((m = NAMED_RE.exec(sql)) !== null) names.add(m[0]); // guarda com prefixo
    const out = {};
    for (const [key, value] of Object.entries(first)) {
      const prefixed = names.has('@' + key) ? '@' + key
        : names.has(':' + key) ? ':' + key
        : names.has('$' + key) ? '$' + key
        : null;
      if (prefixed) out[prefixed] = value;
      else if (key[0] === '@' || key[0] === ':' || key[0] === '$') out[key] = value; // já prefixado
      // campo extra que o SQL não usa: better-sqlite3 ignora, o node:sqlite não.
    }
    return [out];
  }
  return args; // posicionais
}

class Statement {
  constructor(db, sql) {
    this._sql = sql;
    this._stmt = db.prepare(sql);
  }
  run(...args) {
    const r = this._stmt.run(...bindParams(this._sql, args));
    // mesma forma que o better-sqlite3 devolve
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...args) { return this._stmt.get(...bindParams(this._sql, args)); }
  all(...args) { return this._stmt.all(...bindParams(this._sql, args)); }
}

class Database {
  constructor(path, _opts) {
    this._db = new DatabaseSync(path);
  }
  pragma(src) {
    // better-sqlite3: db.pragma('journal_mode = WAL')
    // node:sqlite: não tem .pragma; exec resolve.
    this._db.exec(`PRAGMA ${src}`);
    return true;
  }
  exec(sql) { this._db.exec(sql); }
  prepare(sql) {
    // PRAGMA com resultado precisa de SELECT de função pragma no node:sqlite
    const m = /^PRAGMA\s+table_info\((['"]?)([A-Za-z0-9_]+)\1\)\s*$/i.exec(sql.trim());
    if (m) return new Statement(this._db, `SELECT * FROM pragma_table_info('${m[2]}')`);
    return new Statement(this._db, sql);
  }
  close() { this._db.close(); }
}

module.exports = Database;
module.exports.default = Database;
