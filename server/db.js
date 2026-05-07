// SQLite-backed storage layer.
//
// Replaces the previous JSON/JSONL files (products.json, upcs.json,
// submissions.jsonl, rejected.jsonl) with a single data.db. On first boot
// after deploying this version, any existing JSON/JSONL files in DATA_DIR
// are imported into the new tables and renamed to *.migrated so the
// migration is idempotent.
//
// All write operations are wrapped in transactions where they touch more
// than one row, so a crash mid-write can't leave the catalogue in a
// half-applied state.

const path = require('node:path');
const fs   = require('node:fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname);
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'data.db');

const db = new Database(DB_PATH);
// WAL is the better default for a concurrent-read / occasional-write workload.
// foreign_keys is OFF by default in SQLite — we want it ON so DELETE cascades.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    abv         REAL NOT NULL,
    volume_ml   REAL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upcs (
    upc         TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    flavour     TEXT,
    added_at    TEXT NOT NULL,
    updated_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS upcs_product ON upcs(product_id);

  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    upc         TEXT,
    name        TEXT NOT NULL,
    abv         REAL NOT NULL,
    volume_ml   REAL,
    flavour     TEXT,
    from_name   TEXT,
    people      TEXT,           -- JSON array of names (TEXT for portability)
    user_agent  TEXT,
    received_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_upc          ON submissions(upc);
  CREATE INDEX IF NOT EXISTS submissions_received_at  ON submissions(received_at DESC);

  CREATE TABLE IF NOT EXISTS rejected_upcs (
    upc         TEXT PRIMARY KEY,
    reason      TEXT,
    rejected_at TEXT NOT NULL
  );

  -- Shared sessions. Anyone with the session id can read or write.
  -- updated_at is bumped on any mutation so polling clients can detect change.
  CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    benchmark_preset_key  TEXT
  );

  CREATE TABLE IF NOT EXISTS session_people (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    position    INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_people_session ON session_people(session_id, position);

  -- preset_key is the client-supplied stable id (e.g. 'pstd', 'p2', 'u1730…').
  -- Drinks reference the preset by (session_id, preset_key) so a 'Tall Can'
  -- in session A is independent of a 'Tall Can' in session B.
  CREATE TABLE IF NOT EXISTS session_presets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    preset_key      TEXT NOT NULL,
    name            TEXT NOT NULL,
    volume_ml       REAL NOT NULL,
    abv             REAL NOT NULL,
    kcal_per_100ml  REAL,
    last_used_at    INTEGER,
    UNIQUE(session_id, preset_key)
  );

  CREATE TABLE IF NOT EXISTS session_drinks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    person_id   INTEGER NOT NULL REFERENCES session_people(id) ON DELETE CASCADE,
    preset_key  TEXT,
    name        TEXT NOT NULL,
    flavour     TEXT,
    volume_ml   REAL NOT NULL,
    abv         REAL NOT NULL,
    t           INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_drinks_session ON session_drinks(session_id, t);
  CREATE INDEX IF NOT EXISTS session_drinks_person  ON session_drinks(person_id);
`);

// ---- prepared statements -------------------------------------------------

const stmts = {
  // products
  listProducts: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products`
  ),
  getProductById: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products WHERE id = ?`
  ),
  getProductByName: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products WHERE name = ? COLLATE NOCASE`
  ),
  productsCount: db.prepare(`SELECT COUNT(*) AS n FROM products`),
  insertProduct: db.prepare(
    `INSERT INTO products (id, name, abv, volume_ml, created_at, updated_at)
     VALUES (@id, @name, @abv, @volumeMl, @createdAt, @updatedAt)`
  ),
  updateProduct: db.prepare(
    `UPDATE products
        SET name = @name, abv = @abv, volume_ml = @volumeMl,
            updated_at = @updatedAt
      WHERE id = @id`
  ),
  deleteProductById: db.prepare(`DELETE FROM products WHERE id = ?`),

  // upcs
  listUpcs: db.prepare(
    `SELECT upc, product_id AS productId, flavour,
            added_at AS addedAt, updated_at AS updatedAt
       FROM upcs`
  ),
  getUpc: db.prepare(
    `SELECT upc, product_id AS productId, flavour,
            added_at AS addedAt, updated_at AS updatedAt
       FROM upcs WHERE upc = ?`
  ),
  getUpcsByProduct: db.prepare(
    `SELECT upc, product_id AS productId, flavour,
            added_at AS addedAt, updated_at AS updatedAt
       FROM upcs WHERE product_id = ? ORDER BY upc`
  ),
  upsertUpc: db.prepare(
    `INSERT INTO upcs (upc, product_id, flavour, added_at, updated_at)
     VALUES (@upc, @productId, @flavour, @addedAt, @updatedAt)
     ON CONFLICT(upc) DO UPDATE SET
       product_id = excluded.product_id,
       flavour    = excluded.flavour,
       updated_at = excluded.updated_at`
  ),
  deleteUpc: db.prepare(`DELETE FROM upcs WHERE upc = ?`),
  countUpcsForProduct: db.prepare(`SELECT COUNT(*) AS n FROM upcs WHERE product_id = ?`),

  // joined catalogue (the public /catalog.json shape)
  joinedCatalogue: db.prepare(`
    SELECT u.upc,
           u.product_id AS productId,
           p.name,
           p.abv,
           p.volume_ml AS volumeMl,
           u.flavour
      FROM upcs u
      JOIN products p ON p.id = u.product_id
  `),

  // submissions
  insertSubmission: db.prepare(`
    INSERT INTO submissions
      (upc, name, abv, volume_ml, flavour, from_name, people, user_agent, received_at)
    VALUES
      (@upc, @name, @abv, @volumeMl, @flavour, @fromName, @people, @userAgent, @receivedAt)
  `),
  listSubmissions: db.prepare(`
    SELECT upc, name, abv, volume_ml AS volumeMl, flavour,
           from_name AS [from], people, user_agent AS ua, received_at AS receivedAt
      FROM submissions
     ORDER BY received_at DESC
  `),
  listSubmissionsLimit: db.prepare(`
    SELECT upc, name, abv, volume_ml AS volumeMl, flavour,
           from_name AS [from], people, user_agent AS ua, received_at AS receivedAt
      FROM submissions
     ORDER BY received_at DESC
     LIMIT ?
  `),
  countSubmissions: db.prepare(`SELECT COUNT(*) AS n FROM submissions`),

  // rejected
  upsertRejected: db.prepare(`
    INSERT INTO rejected_upcs (upc, reason, rejected_at)
    VALUES (?, ?, ?)
    ON CONFLICT(upc) DO UPDATE SET
      reason      = excluded.reason,
      rejected_at = excluded.rejected_at
  `),
  listRejected: db.prepare(`
    SELECT upc, reason, rejected_at AS rejectedAt FROM rejected_upcs
  `),
  countRejected: db.prepare(`SELECT COUNT(*) AS n FROM rejected_upcs`),
  isRejected: db.prepare(`SELECT 1 FROM rejected_upcs WHERE upc = ?`),

  // ---- sessions ---------------------------------------------------------
  insertSession: db.prepare(`
    INSERT INTO sessions (id, name, created_at, updated_at, benchmark_preset_key)
    VALUES (@id, @name, @createdAt, @updatedAt, @benchmarkPresetKey)
  `),
  getSession: db.prepare(`
    SELECT id, name,
           created_at AS createdAt,
           updated_at AS updatedAt,
           benchmark_preset_key AS benchmarkPresetKey
      FROM sessions WHERE id = ?
  `),
  updateSessionName: db.prepare(`
    UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?
  `),
  updateSessionBenchmark: db.prepare(`
    UPDATE sessions SET benchmark_preset_key = ?, updated_at = ? WHERE id = ?
  `),
  touchSession: db.prepare(`
    UPDATE sessions SET updated_at = ? WHERE id = ?
  `),
  deleteSessionStmt: db.prepare(`DELETE FROM sessions WHERE id = ?`),

  // admin overview: sessions + counts (one query thanks to LEFT JOIN + COUNT).
  listSessionsAdmin: db.prepare(`
    SELECT s.id,
           s.name,
           s.created_at AS createdAt,
           s.updated_at AS updatedAt,
           s.benchmark_preset_key AS benchmarkPresetKey,
           (SELECT COUNT(*) FROM session_people  WHERE session_id = s.id) AS peopleCount,
           (SELECT COUNT(*) FROM session_drinks  WHERE session_id = s.id) AS drinkCount,
           (SELECT MAX(t)    FROM session_drinks WHERE session_id = s.id) AS lastDrinkAt
      FROM sessions s
     ORDER BY s.updated_at DESC
  `),

  // ---- session_people ---------------------------------------------------
  insertPerson: db.prepare(`
    INSERT INTO session_people (session_id, name, position, created_at)
    VALUES (@sessionId, @name, @position, @createdAt)
  `),
  listPeople: db.prepare(`
    SELECT id, name, position, created_at AS createdAt
      FROM session_people
     WHERE session_id = ?
     ORDER BY position ASC, id ASC
  `),
  getPerson: db.prepare(`
    SELECT id, session_id AS sessionId, name, position, created_at AS createdAt
      FROM session_people
     WHERE id = ?
  `),
  updatePersonName: db.prepare(`
    UPDATE session_people SET name = ? WHERE id = ?
  `),
  deletePersonStmt: db.prepare(`DELETE FROM session_people WHERE id = ?`),
  countPeople: db.prepare(`
    SELECT COUNT(*) AS n FROM session_people WHERE session_id = ?
  `),
  maxPersonPosition: db.prepare(`
    SELECT COALESCE(MAX(position), -1) AS p FROM session_people WHERE session_id = ?
  `),

  // ---- session_presets --------------------------------------------------
  insertPreset: db.prepare(`
    INSERT INTO session_presets
      (session_id, preset_key, name, volume_ml, abv, kcal_per_100ml, last_used_at)
    VALUES
      (@sessionId, @presetKey, @name, @volumeMl, @abv, @kcalPer100ml, @lastUsedAt)
  `),
  upsertPreset: db.prepare(`
    INSERT INTO session_presets
      (session_id, preset_key, name, volume_ml, abv, kcal_per_100ml, last_used_at)
    VALUES
      (@sessionId, @presetKey, @name, @volumeMl, @abv, @kcalPer100ml, @lastUsedAt)
    ON CONFLICT(session_id, preset_key) DO UPDATE SET
      name           = excluded.name,
      volume_ml      = excluded.volume_ml,
      abv            = excluded.abv,
      kcal_per_100ml = excluded.kcal_per_100ml,
      last_used_at   = COALESCE(excluded.last_used_at, session_presets.last_used_at)
  `),
  listPresets: db.prepare(`
    SELECT preset_key AS presetKey, name,
           volume_ml AS volumeMl, abv,
           kcal_per_100ml AS kcalPer100ml,
           last_used_at AS lastUsedAt
      FROM session_presets
     WHERE session_id = ?
  `),
  getPreset: db.prepare(`
    SELECT preset_key AS presetKey, name,
           volume_ml AS volumeMl, abv,
           kcal_per_100ml AS kcalPer100ml,
           last_used_at AS lastUsedAt
      FROM session_presets
     WHERE session_id = ? AND preset_key = ?
  `),
  updatePresetCore: db.prepare(`
    UPDATE session_presets
       SET name = @name, volume_ml = @volumeMl, abv = @abv
     WHERE session_id = @sessionId AND preset_key = @presetKey
  `),
  touchPresetStmt: db.prepare(`
    UPDATE session_presets SET last_used_at = ? WHERE session_id = ? AND preset_key = ?
  `),
  deletePresetStmt: db.prepare(`
    DELETE FROM session_presets WHERE session_id = ? AND preset_key = ?
  `),

  // ---- session_drinks ---------------------------------------------------
  insertDrink: db.prepare(`
    INSERT INTO session_drinks
      (session_id, person_id, preset_key, name, flavour, volume_ml, abv, t, created_at)
    VALUES
      (@sessionId, @personId, @presetKey, @name, @flavour, @volumeMl, @abv, @t, @createdAt)
  `),
  listDrinks: db.prepare(`
    SELECT id, person_id AS personId,
           preset_key AS presetKey,
           name, flavour,
           volume_ml AS volumeMl,
           abv, t,
           created_at AS createdAt
      FROM session_drinks
     WHERE session_id = ?
     ORDER BY t ASC, id ASC
  `),
  getDrink: db.prepare(`
    SELECT id, session_id AS sessionId, person_id AS personId,
           preset_key AS presetKey, name, flavour,
           volume_ml AS volumeMl, abv, t,
           created_at AS createdAt
      FROM session_drinks
     WHERE id = ?
  `),
  updateDrinkStmt: db.prepare(`
    UPDATE session_drinks
       SET name = @name, flavour = @flavour,
           volume_ml = @volumeMl, abv = @abv,
           preset_key = @presetKey
     WHERE id = @id
  `),
  updateDrinksByPresetStmt: db.prepare(`
    UPDATE session_drinks
       SET name = @name, volume_ml = @volumeMl, abv = @abv
     WHERE session_id = @sessionId AND preset_key = @presetKey
  `),
  deleteDrinkStmt: db.prepare(`DELETE FROM session_drinks WHERE id = ?`),
};

// JSON column helpers — submissions.people is stored as a JSON string
// because SQLite has no native array type, but we want to surface a real
// array to callers.
function decodePeople(raw) {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; }
  catch { return null; }
}
function rehydrateSubmission(row) {
  if (!row) return row;
  const p = decodePeople(row.people);
  if (p) row.people = p; else delete row.people;
  if (!row.flavour) delete row.flavour;
  if (!row.from)    delete row.from;
  if (!row.upc)     delete row.upc;
  if (row.volumeMl == null) delete row.volumeMl;
  if (!row.ua)      delete row.ua;
  return row;
}

// ---- public API ---------------------------------------------------------

function listProducts() { return stmts.listProducts.all(); }
function getProductById(id)   { return stmts.getProductById.get(id) || null; }
function getProductByName(n)  { return stmts.getProductByName.get(n) || null; }
function listUpcs()           { return stmts.listUpcs.all(); }
function getUpc(upc)          { return stmts.getUpc.get(upc) || null; }
function getUpcsByProduct(id) { return stmts.getUpcsByProduct.all(id); }
function joinedCatalogue()    { return stmts.joinedCatalogue.all(); }

function insertProduct(prod) { stmts.insertProduct.run(prod); }
function updateProduct(prod) { stmts.updateProduct.run(prod); }

// Returns the number of UPC rows that cascaded out.
function deleteProduct(id) {
  const removed = stmts.countUpcsForProduct.get(id).n;
  const info = stmts.deleteProductById.run(id);
  return { deleted: info.changes > 0, removedUpcs: removed };
}

function upsertUpc(row) { stmts.upsertUpc.run(row); }
function deleteUpc(upc) { return stmts.deleteUpc.run(upc).changes > 0; }

// Insert a curated entry by (name, abv, volumeMl?, upc, flavour?). Used by
// the legacy /api/curated adapter so the existing admin GUI keeps working.
// Wraps product upsert + upc upsert in one transaction.
const upsertCuratedTx = db.transaction((entry) => {
  const now = new Date().toISOString();
  let prod = stmts.getProductByName.get(entry.name);
  if (!prod) {
    prod = {
      id: entry.makeProductId(),
      name: entry.name,
      abv: entry.abv,
      volumeMl: entry.volumeMl,
      createdAt: now,
      updatedAt: now,
    };
    stmts.insertProduct.run(prod);
  } else {
    prod.abv = entry.abv;
    if (entry.volumeMl != null) prod.volumeMl = entry.volumeMl;
    prod.updatedAt = now;
    stmts.updateProduct.run(prod);
  }
  const existing = stmts.getUpc.get(entry.upc);
  stmts.upsertUpc.run({
    upc:       entry.upc,
    productId: prod.id,
    flavour:   entry.flavour,
    addedAt:   existing ? existing.addedAt : now,
    updatedAt: now,
  });
  return prod;
});
function upsertCurated(entry) { return upsertCuratedTx(entry); }

function appendSubmission(sub) {
  stmts.insertSubmission.run({
    upc:        sub.upc || null,
    name:       sub.name,
    abv:        sub.abv,
    volumeMl:   sub.volumeMl == null ? null : sub.volumeMl,
    flavour:    sub.flavour || null,
    fromName:   sub.from || null,
    people:     Array.isArray(sub.people) ? JSON.stringify(sub.people) : null,
    userAgent:  sub.ua || null,
    receivedAt: sub.receivedAt,
  });
}
function listSubmissions(opts = {}) {
  const rows = opts.limit
    ? stmts.listSubmissionsLimit.all(opts.limit)
    : stmts.listSubmissions.all();
  return rows.map(rehydrateSubmission);
}
function countSubmissions() { return stmts.countSubmissions.get().n; }

function appendRejected(upc, reason) {
  stmts.upsertRejected.run(upc, reason || null, new Date().toISOString());
}
function listRejected() { return stmts.listRejected.all(); }
function countRejected() { return stmts.countRejected.get().n; }
function isRejected(upc) { return !!stmts.isRejected.get(upc); }

// ---- session DAO -------------------------------------------------------

const crypto = require('node:crypto');

// 16 random bytes → 22-char base64url (~128 bits of entropy). Ample for
// pure-obfuscation auth — collision probability is astronomically low.
function genSessionId() {
  return crypto.randomBytes(16).toString('base64url');
}

// Default name when the client doesn't supply one. UTC date keeps the
// server reproducible regardless of TZ; the client typically sends its own.
function defaultSessionName(now) {
  const d = new Date(now);
  return d.toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' });
}

function nowIso() { return new Date().toISOString(); }

const createSessionTx = db.transaction((payload) => {
  const id = payload.id || genSessionId();
  const now = nowIso();
  const name = (payload.name || '').toString().trim().slice(0, 60) || defaultSessionName(now);
  stmts.insertSession.run({
    id, name,
    createdAt: now,
    updatedAt: now,
    benchmarkPresetKey: payload.benchmarkPresetKey || null,
  });

  // Seed people in order. Position auto-assigned if not provided.
  if (Array.isArray(payload.people)) {
    payload.people.forEach((p, idx) => {
      const pname = (p && p.name || '').toString().trim().slice(0, 40);
      if (!pname) return;
      stmts.insertPerson.run({
        sessionId: id,
        name: pname,
        position: typeof p.position === 'number' ? p.position : idx,
        createdAt: now,
      });
    });
  }

  // Seed presets. Skip duplicates within the seed list (last-wins via upsert).
  if (Array.isArray(payload.presets)) {
    for (const p of payload.presets) {
      if (!p || !p.presetKey || !p.name) continue;
      const vol = Number(p.volumeMl);
      const abv = Number(p.abv);
      if (!Number.isFinite(vol) || vol <= 0) continue;
      if (!Number.isFinite(abv) || abv < 0 || abv > 100) continue;
      stmts.upsertPreset.run({
        sessionId:    id,
        presetKey:    String(p.presetKey).slice(0, 60),
        name:         String(p.name).slice(0, 40),
        volumeMl:     +vol.toFixed(2),
        abv:          +abv.toFixed(2),
        kcalPer100ml: p.kcalPer100ml == null ? null : Number(p.kcalPer100ml),
        lastUsedAt:   p.lastUsedAt == null ? null : Number(p.lastUsedAt),
      });
    }
  }

  return id;
});

function createSession(payload) {
  const id = createSessionTx(payload || {});
  return getSessionFull(id);
}

function getSessionFull(id) {
  const s = stmts.getSession.get(id);
  if (!s) return null;
  s.people  = stmts.listPeople.all(id);
  s.presets = stmts.listPresets.all(id);
  s.drinks  = stmts.listDrinks.all(id);
  return s;
}

function getSessionMeta(id) { return stmts.getSession.get(id) || null; }

function listSessions() {
  return stmts.listSessionsAdmin.all();
}

function deleteSession(id) {
  return stmts.deleteSessionStmt.run(id).changes > 0;
}

// All mutations bump updated_at so polling clients can short-circuit.
function touchSession(sessionId) {
  stmts.touchSession.run(nowIso(), sessionId);
}

function renameSession(sessionId, name) {
  const trimmed = (name || '').toString().trim().slice(0, 60);
  if (!trimmed) return false;
  const info = stmts.updateSessionName.run(trimmed, nowIso(), sessionId);
  return info.changes > 0;
}

function setBenchmark(sessionId, presetKey) {
  const key = presetKey == null ? null : String(presetKey).slice(0, 60);
  stmts.updateSessionBenchmark.run(key, nowIso(), sessionId);
}

const addPersonTx = db.transaction((sessionId, name) => {
  const pos = stmts.maxPersonPosition.get(sessionId).p + 1;
  const info = stmts.insertPerson.run({
    sessionId,
    name: (name || '').toString().trim().slice(0, 40) || `Friend ${pos}`,
    position: pos,
    createdAt: nowIso(),
  });
  stmts.touchSession.run(nowIso(), sessionId);
  return info.lastInsertRowid;
});
function addPerson(sessionId, name) {
  const id = addPersonTx(sessionId, name);
  return stmts.getPerson.get(id);
}

function renamePerson(sessionId, personId, name) {
  const p = stmts.getPerson.get(personId);
  if (!p || p.sessionId !== sessionId) return false;
  const trimmed = (name || '').toString().trim().slice(0, 40);
  if (!trimmed) return false;
  stmts.updatePersonName.run(trimmed, personId);
  stmts.touchSession.run(nowIso(), sessionId);
  return true;
}

function removePerson(sessionId, personId) {
  const p = stmts.getPerson.get(personId);
  if (!p || p.sessionId !== sessionId) return false;
  // Refuse if this would empty the session.
  if (stmts.countPeople.get(sessionId).n <= 1) return false;
  stmts.deletePersonStmt.run(personId);
  stmts.touchSession.run(nowIso(), sessionId);
  return true;
}

const upsertPresetTx = db.transaction((sessionId, p) => {
  stmts.upsertPreset.run({
    sessionId,
    presetKey:    String(p.presetKey).slice(0, 60),
    name:         String(p.name).slice(0, 40),
    volumeMl:     +Number(p.volumeMl).toFixed(2),
    abv:          +Number(p.abv).toFixed(2),
    kcalPer100ml: p.kcalPer100ml == null ? null : Number(p.kcalPer100ml),
    lastUsedAt:   p.lastUsedAt == null ? null : Number(p.lastUsedAt),
  });
  stmts.touchSession.run(nowIso(), sessionId);
});
function upsertPreset(sessionId, p) {
  upsertPresetTx(sessionId, p);
  return stmts.getPreset.get(sessionId, p.presetKey);
}

// "Edit all of this type": mutates the preset row AND every drink linked to it.
const updatePresetCascadeTx = db.transaction((sessionId, presetKey, fields) => {
  const cur = stmts.getPreset.get(sessionId, presetKey);
  if (!cur) return null;
  const next = {
    sessionId,
    presetKey,
    name:     fields.name     != null ? String(fields.name).slice(0, 40) : cur.name,
    volumeMl: fields.volumeMl != null ? +Number(fields.volumeMl).toFixed(2) : cur.volumeMl,
    abv:      fields.abv      != null ? +Number(fields.abv).toFixed(2) : cur.abv,
  };
  stmts.updatePresetCore.run(next);
  stmts.updateDrinksByPresetStmt.run(next);
  stmts.touchSession.run(nowIso(), sessionId);
  return stmts.getPreset.get(sessionId, presetKey);
});
function updatePresetCascade(sessionId, presetKey, fields) {
  return updatePresetCascadeTx(sessionId, presetKey, fields || {});
}

function touchPreset(sessionId, presetKey) {
  stmts.touchPresetStmt.run(Date.now(), sessionId, presetKey);
  stmts.touchSession.run(nowIso(), sessionId);
}

function removePreset(sessionId, presetKey) {
  const info = stmts.deletePresetStmt.run(sessionId, presetKey);
  if (info.changes === 0) return false;
  stmts.touchSession.run(nowIso(), sessionId);
  return true;
}

const addDrinkTx = db.transaction((sessionId, drink) => {
  // Verify person belongs to this session.
  const person = stmts.getPerson.get(drink.personId);
  if (!person || person.sessionId !== sessionId) {
    throw Object.assign(new Error('person not in session'), { status: 400 });
  }
  const now = nowIso();
  const info = stmts.insertDrink.run({
    sessionId,
    personId:  drink.personId,
    presetKey: drink.presetKey || null,
    name:      String(drink.name || '').slice(0, 60) || `${Math.round(drink.volumeMl)} ml · ${drink.abv}%`,
    flavour:   drink.flavour ? String(drink.flavour).slice(0, 60) : null,
    volumeMl:  +Number(drink.volumeMl).toFixed(2),
    abv:       +Number(drink.abv).toFixed(2),
    t:         drink.t == null ? Date.now() : Number(drink.t),
    createdAt: now,
  });
  // If linked to a preset, bump its lastUsedAt so the recency sort picks it up.
  if (drink.presetKey) {
    stmts.touchPresetStmt.run(Date.now(), sessionId, drink.presetKey);
  }
  stmts.touchSession.run(now, sessionId);
  return info.lastInsertRowid;
});
function addDrink(sessionId, drink) {
  const id = addDrinkTx(sessionId, drink);
  return stmts.getDrink.get(id);
}

function updateDrink(sessionId, drinkId, fields) {
  const cur = stmts.getDrink.get(drinkId);
  if (!cur || cur.sessionId !== sessionId) return null;
  const next = {
    id: drinkId,
    name:      fields.name     != null ? String(fields.name).slice(0, 60) : cur.name,
    flavour:   fields.flavour !== undefined
                  ? (fields.flavour ? String(fields.flavour).slice(0, 60) : null)
                  : (cur.flavour || null),
    volumeMl:  fields.volumeMl != null ? +Number(fields.volumeMl).toFixed(2) : cur.volumeMl,
    abv:       fields.abv      != null ? +Number(fields.abv).toFixed(2) : cur.abv,
    // Editing a single drink unlinks it from its preset (matches frontend
    // semantics: "all of this type" goes through updatePresetCascade).
    presetKey: fields.unlinkPreset === true ? null : (cur.presetKey || null),
  };
  stmts.updateDrinkStmt.run(next);
  stmts.touchSession.run(nowIso(), sessionId);
  return stmts.getDrink.get(drinkId);
}

function removeDrink(sessionId, drinkId) {
  const cur = stmts.getDrink.get(drinkId);
  if (!cur || cur.sessionId !== sessionId) return false;
  stmts.deleteDrinkStmt.run(drinkId);
  stmts.touchSession.run(nowIso(), sessionId);
  return true;
}

// ---- one-shot migration from JSON/JSONL ---------------------------------
//
// If products is empty and the legacy JSON files are present, slurp them
// in. Renames the files to *.migrated afterwards so this is idempotent.

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (e) {
    console.warn(`db migration: failed to read ${file}:`, e.message);
    return fallback;
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function migrateFromJsonIfNeeded() {
  if (stmts.productsCount.get().n > 0) return;   // already populated, nothing to do

  const PRODUCTS_JSON = path.join(DATA_DIR, 'products.json');
  const UPCS_JSON     = path.join(DATA_DIR, 'upcs.json');
  const SUBMIT_LOG    = path.join(DATA_DIR, 'submissions.jsonl');
  const REJECTED      = path.join(DATA_DIR, 'rejected.jsonl');

  const products    = readJsonSafe(PRODUCTS_JSON, []);
  const upcs        = readJsonSafe(UPCS_JSON, []);
  const submissions = readJsonl(SUBMIT_LOG);
  const rejected    = readJsonl(REJECTED);

  if (!products.length && !upcs.length && !submissions.length && !rejected.length) {
    console.log('db: empty start (no JSON files to import).');
    return;
  }

  console.log(
    `db migration: importing ${products.length} products, ${upcs.length} upcs, ` +
    `${submissions.length} submissions, ${rejected.length} rejected…`
  );

  const tx = db.transaction(() => {
    for (const p of products) {
      stmts.insertProduct.run({
        id:        p.id,
        name:      p.name,
        abv:       p.abv,
        volumeMl:  p.volumeMl == null ? null : p.volumeMl,
        createdAt: p.createdAt || new Date().toISOString(),
        updatedAt: p.updatedAt || p.createdAt || new Date().toISOString(),
      });
    }
    for (const u of upcs) {
      stmts.upsertUpc.run({
        upc:       u.upc,
        productId: u.productId,
        flavour:   u.flavour || null,
        addedAt:   u.addedAt || new Date().toISOString(),
        updatedAt: u.updatedAt || null,
      });
    }
    for (const s of submissions) {
      stmts.insertSubmission.run({
        upc:        s.upc || null,
        name:       s.name,
        abv:        s.abv,
        volumeMl:   s.volumeMl == null ? null : s.volumeMl,
        flavour:    s.flavour || null,
        fromName:   s.from || null,
        people:     Array.isArray(s.people) ? JSON.stringify(s.people) : null,
        userAgent:  s.ua || null,
        receivedAt: s.receivedAt || new Date().toISOString(),
      });
    }
    for (const r of rejected) {
      if (!r.upc) continue;
      stmts.upsertRejected.run(r.upc, r.reason || null, r.at || new Date().toISOString());
    }
  });
  tx();

  // Move the source files aside so a restart doesn't try to re-import.
  for (const f of [PRODUCTS_JSON, UPCS_JSON, SUBMIT_LOG, REJECTED]) {
    if (fs.existsSync(f)) {
      try { fs.renameSync(f, f + '.migrated'); }
      catch (e) { console.warn(`db migration: rename ${f} failed:`, e.message); }
    }
  }
  console.log('db migration: done.');
}

module.exports = {
  db,
  DB_PATH,

  // products
  listProducts, getProductById, getProductByName,
  insertProduct, updateProduct, deleteProduct,

  // upcs
  listUpcs, getUpc, getUpcsByProduct,
  upsertUpc, deleteUpc,

  // catalogue
  joinedCatalogue,

  // legacy adapter
  upsertCurated,

  // submissions
  appendSubmission, listSubmissions, countSubmissions,

  // rejected
  appendRejected, listRejected, countRejected, isRejected,

  // sessions
  genSessionId,
  createSession, getSessionFull, getSessionMeta, listSessions, deleteSession,
  renameSession, setBenchmark, touchSession,
  addPerson, renamePerson, removePerson,
  upsertPreset, updatePresetCascade, touchPreset, removePreset,
  addDrink, updateDrink, removeDrink,

  // bootstrap
  migrateFromJsonIfNeeded,
};
