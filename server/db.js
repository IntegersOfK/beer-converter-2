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
const crypto = require('node:crypto');
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
    name        TEXT NOT NULL COLLATE NOCASE,
    abv         REAL NOT NULL,
    volume_ml   REAL,
    category    TEXT,
    curated     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS products_name ON products(name COLLATE NOCASE);

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
    public_id             TEXT UNIQUE,
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
    input_kind      TEXT NOT NULL DEFAULT 'whole',
    components_json TEXT,
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
    input_kind  TEXT NOT NULL DEFAULT 'whole',
    components_json TEXT,
    t           INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_drinks_session ON session_drinks(session_id, t);
  CREATE INDEX IF NOT EXISTS session_drinks_person  ON session_drinks(person_id);

  CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    person_id   INTEGER REFERENCES session_people(id) ON DELETE SET NULL,
    drink_id    INTEGER,
    data        TEXT,
    t           INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_events_session ON session_events(session_id, t, id);

  CREATE TABLE IF NOT EXISTS session_comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    person_id    INTEGER REFERENCES session_people(id) ON DELETE SET NULL,
    author_name  TEXT, -- Free-text name
    text         TEXT NOT NULL,
    t            INTEGER NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_comments_session ON session_comments(session_id, t);

  CREATE TABLE IF NOT EXISTS session_comment_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL REFERENCES session_comments(id) ON DELETE CASCADE,
    person_id   INTEGER REFERENCES session_people(id) ON DELETE CASCADE,
    device_id   TEXT, -- For anonymous reactions
    author_name TEXT,
    emoji       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(comment_id, person_id, device_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS session_comment_reactions_comment ON session_comment_reactions(comment_id);
`);

// ---- migration: products gets category + curated; drop UNIQUE(name) -------
// SQLite has no DROP CONSTRAINT, so we rebuild the table. Foreign keys must
// be disabled for the swap or the upcs rows would cascade-delete. Existing
// rows are flagged curated=1 because they all came from the hand-curated
// admin path; the CSV importer below inserts new rows with curated=0.
const productsTableInfo = db.prepare("PRAGMA table_info(products)").all();
if (!productsTableInfo.some(c => c.name === 'category') || !productsTableInfo.some(c => c.name === 'curated')) {
  console.log('Migration: adding category + curated to products, dropping UNIQUE(name)');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE products_new (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL COLLATE NOCASE,
        abv         REAL NOT NULL,
        volume_ml   REAL,
        category    TEXT,
        curated     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      INSERT INTO products_new (id, name, abv, volume_ml, category, curated, created_at, updated_at)
        SELECT id, name, abv, volume_ml, NULL, 1, created_at, updated_at FROM products;
      DROP TABLE products;
      ALTER TABLE products_new RENAME TO products;
      CREATE INDEX IF NOT EXISTS products_name ON products(name COLLATE NOCASE);
    `);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// ---- migration: add author_name to session_comments -----------------------
const tableInfo = db.prepare("PRAGMA table_info(session_comments)").all();
if (!tableInfo.some(c => c.name === 'author_name')) {
  console.log('Migration: adding author_name to session_comments');
  db.exec("ALTER TABLE session_comments ADD COLUMN author_name TEXT;");
}

const reactionTableInfo = db.prepare("PRAGMA table_info(session_comment_reactions)").all();
if (!reactionTableInfo.some(c => c.name === 'author_name')) {
  console.log('Migration: adding author_name to session_comment_reactions');
  db.exec("ALTER TABLE session_comment_reactions ADD COLUMN author_name TEXT;");
}

const sessionTableInfo = db.prepare("PRAGMA table_info(sessions)").all();
if (!sessionTableInfo.some(c => c.name === 'public_id')) {
  console.log('Migration: adding public_id to sessions');
  db.exec("ALTER TABLE sessions ADD COLUMN public_id TEXT;");
}
const missingPublicIds = db.prepare("SELECT id FROM sessions WHERE public_id IS NULL OR public_id = ''").all();
if (missingPublicIds.length) {
  const updatePublicId = db.prepare("UPDATE sessions SET public_id = ? WHERE id = ?");
  const existingPublicId = db.prepare("SELECT 1 FROM sessions WHERE public_id = ?");
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      let publicId;
      do { publicId = genSessionId(); } while (existingPublicId.get(publicId));
      updatePublicId.run(publicId, row.id);
    }
  });
  tx(missingPublicIds);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(public_id);");

const drinkTableInfo = db.prepare("PRAGMA table_info(session_drinks)").all();
if (!drinkTableInfo.some(c => c.name === 'input_kind')) {
  console.log('Migration: adding input_kind to session_drinks');
  db.exec("ALTER TABLE session_drinks ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'whole';");
}
if (!drinkTableInfo.some(c => c.name === 'components_json')) {
  console.log('Migration: adding components_json to session_drinks');
  db.exec("ALTER TABLE session_drinks ADD COLUMN components_json TEXT;");
}

const presetTableInfo = db.prepare("PRAGMA table_info(session_presets)").all();
if (!presetTableInfo.some(c => c.name === 'input_kind')) {
  console.log('Migration: adding input_kind to session_presets');
  db.exec("ALTER TABLE session_presets ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'whole';");
}
if (!presetTableInfo.some(c => c.name === 'components_json')) {
  console.log('Migration: adding components_json to session_presets');
  db.exec("ALTER TABLE session_presets ADD COLUMN components_json TEXT;");
}

// ---- prepared statements -------------------------------------------------

const stmts = {
  // products
  listProducts: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl, category, curated,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products`
  ),
  getProductById: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl, category, curated,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products WHERE id = ?`
  ),
  // Name lookup returns the curated row when one exists, otherwise the most
  // recently-updated row. The hand-curated entry always wins so the legacy
  // /api/curated adapter doesn't accidentally rewrite a CSV-imported product.
  getProductByName: db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl, category, curated,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products WHERE name = ? COLLATE NOCASE
       ORDER BY curated DESC, updated_at DESC LIMIT 1`
  ),
  productsCount: db.prepare(`SELECT COUNT(*) AS n FROM products`),
  insertProduct: db.prepare(
    `INSERT INTO products (id, name, abv, volume_ml, category, curated, created_at, updated_at)
     VALUES (@id, @name, @abv, @volumeMl, @category, @curated, @createdAt, @updatedAt)`
  ),
  updateProduct: db.prepare(
    `UPDATE products
        SET name = @name, abv = @abv, volume_ml = @volumeMl,
            category = @category, curated = @curated,
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
           p.category,
           p.curated,
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
    INSERT INTO sessions (id, public_id, name, created_at, updated_at, benchmark_preset_key)
    VALUES (@id, @publicId, @name, @createdAt, @updatedAt, @benchmarkPresetKey)
  `),
  getSession: db.prepare(`
    SELECT id,
           public_id AS publicId,
           name,
           created_at AS createdAt,
           updated_at AS updatedAt,
           benchmark_preset_key AS benchmarkPresetKey
      FROM sessions WHERE id = ?
  `),
  getSessionByPublicId: db.prepare(`
    SELECT id,
           public_id AS publicId,
           name,
           created_at AS createdAt,
           updated_at AS updatedAt,
           benchmark_preset_key AS benchmarkPresetKey
      FROM sessions WHERE public_id = ?
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
           s.public_id AS publicId,
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
      (session_id, preset_key, name, volume_ml, abv, kcal_per_100ml, last_used_at, input_kind, components_json)
    VALUES
      (@sessionId, @presetKey, @name, @volumeMl, @abv, @kcalPer100ml, @lastUsedAt, @inputKind, @componentsJson)
  `),
  upsertPreset: db.prepare(`
    INSERT INTO session_presets
      (session_id, preset_key, name, volume_ml, abv, kcal_per_100ml, last_used_at, input_kind, components_json)
    VALUES
      (@sessionId, @presetKey, @name, @volumeMl, @abv, @kcalPer100ml, @lastUsedAt, @inputKind, @componentsJson)
    ON CONFLICT(session_id, preset_key) DO UPDATE SET
      name            = excluded.name,
      volume_ml       = excluded.volume_ml,
      abv             = excluded.abv,
      kcal_per_100ml  = excluded.kcal_per_100ml,
      last_used_at    = COALESCE(excluded.last_used_at, session_presets.last_used_at),
      input_kind      = excluded.input_kind,
      components_json = excluded.components_json
  `),
  listPresets: db.prepare(`
    SELECT preset_key AS presetKey, name,
           volume_ml AS volumeMl, abv,
           kcal_per_100ml AS kcalPer100ml,
           last_used_at AS lastUsedAt,
           input_kind AS inputKind,
           components_json AS componentsJson
      FROM session_presets
     WHERE session_id = ?
  `),
  getPreset: db.prepare(`
    SELECT preset_key AS presetKey, name,
           volume_ml AS volumeMl, abv,
           kcal_per_100ml AS kcalPer100ml,
           last_used_at AS lastUsedAt,
           input_kind AS inputKind,
           components_json AS componentsJson
      FROM session_presets
     WHERE session_id = ? AND preset_key = ?
  `),
  updatePresetCore: db.prepare(`
    UPDATE session_presets
       SET name = @name, volume_ml = @volumeMl, abv = @abv,
           input_kind = @inputKind, components_json = @componentsJson
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
      (session_id, person_id, preset_key, name, flavour, volume_ml, abv, input_kind, components_json, t, created_at)
    VALUES
      (@sessionId, @personId, @presetKey, @name, @flavour, @volumeMl, @abv, @inputKind, @componentsJson, @t, @createdAt)
  `),
  listDrinks: db.prepare(`
    SELECT id, person_id AS personId,
           preset_key AS presetKey,
           name, flavour,
           volume_ml AS volumeMl,
           abv, input_kind AS inputKind, components_json AS componentsJson, t,
           created_at AS createdAt
      FROM session_drinks
     WHERE session_id = ?
     ORDER BY t ASC, id ASC
  `),
  getDrink: db.prepare(`
    SELECT id, session_id AS sessionId, person_id AS personId,
           preset_key AS presetKey, name, flavour,
           volume_ml AS volumeMl, abv, input_kind AS inputKind, components_json AS componentsJson, t,
           created_at AS createdAt
      FROM session_drinks
     WHERE id = ?
  `),
  updateDrinkStmt: db.prepare(`
    UPDATE session_drinks
       SET name = @name, flavour = @flavour,
           volume_ml = @volumeMl, abv = @abv,
           input_kind = @inputKind, components_json = @componentsJson,
           preset_key = @presetKey
     WHERE id = @id
  `),
  updateDrinksByPresetStmt: db.prepare(`
    UPDATE session_drinks
       SET name = @name, volume_ml = @volumeMl, abv = @abv,
           input_kind = @inputKind, components_json = @componentsJson
     WHERE session_id = @sessionId AND preset_key = @presetKey
  `),
  deleteDrinkStmt: db.prepare(`DELETE FROM session_drinks WHERE id = ?`),

  // ---- session_events ---------------------------------------------------
  insertEvent: db.prepare(`
    INSERT INTO session_events (session_id, type, person_id, drink_id, data, t, created_at)
    VALUES (@sessionId, @type, @personId, @drinkId, @data, @t, @createdAt)
  `),
  listEvents: db.prepare(`
    SELECT id, type, person_id AS personId, drink_id AS drinkId, data, t, created_at AS createdAt
      FROM session_events
     WHERE session_id = ?
     ORDER BY t ASC, id ASC
  `),

  // ---- session_comments -------------------------------------------------
  insertComment: db.prepare(`
    INSERT INTO session_comments (session_id, person_id, author_name, text, t, created_at)
    VALUES (@sessionId, @personId, @authorName, @text, @t, @createdAt)
  `),
  listComments: db.prepare(`
    SELECT id, person_id AS personId, author_name AS authorName, text, t, created_at AS createdAt
      FROM session_comments
     WHERE session_id = ?
     ORDER BY t ASC, id ASC
  `),
  getComment: db.prepare(`
    SELECT id, session_id AS sessionId, person_id AS personId, author_name AS authorName, text, t, created_at AS createdAt
      FROM session_comments
     WHERE id = ?
  `),
  updateCommentStmt: db.prepare(`
    UPDATE session_comments SET text = ?, t = ? WHERE id = ?
  `),
  deleteCommentStmt: db.prepare(`DELETE FROM session_comments WHERE id = ?`),

  // ---- session_comment_reactions ----------------------------------------
  insertReaction: db.prepare(`
    INSERT INTO session_comment_reactions (comment_id, person_id, device_id, author_name, emoji, created_at)
    VALUES (@commentId, @personId, @deviceId, @authorName, @emoji, @createdAt)
  `),
  deleteReaction: db.prepare(`
    DELETE FROM session_comment_reactions 
     WHERE comment_id = @commentId 
       AND emoji = @emoji 
       AND (person_id = @personId OR (@personId IS NULL AND person_id IS NULL))
       AND (device_id = @deviceId OR (@deviceId IS NULL AND device_id IS NULL))
  `),
  listReactionsForSession: db.prepare(`
    SELECT r.comment_id AS commentId, r.emoji, r.person_id AS personId, r.device_id AS deviceId, r.author_name AS authorName
      FROM session_comment_reactions r
      JOIN session_comments c ON c.id = r.comment_id
     WHERE c.session_id = ?
  `),
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

// Paginated admin products listing — includes expanded UPCs per product.
function listProductsPaginated({ q = '', page = 1, limit = 50, curatedOnly = false } = {}) {
  const whereParts = [];
  const whereParams = [];
  if (curatedOnly) { whereParts.push('curated = 1'); }
  if (q) {
    whereParts.push(
      `(name LIKE ? COLLATE NOCASE OR id IN (SELECT product_id FROM upcs WHERE upc LIKE ?))`
    );
    whereParams.push(`%${q}%`, `%${q}%`);
  }
  const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM products ${where}`).get(...whereParams) || {}).n || 0;
  const rows = db.prepare(
    `SELECT id, name, abv, volume_ml AS volumeMl, category, curated,
            created_at AS createdAt, updated_at AS updatedAt
       FROM products ${where}
      ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(...whereParams, limit, (page - 1) * limit);
  const ids = rows.map(r => r.id);
  const upcRows = ids.length
    ? db.prepare(
        `SELECT upc, product_id AS productId, flavour, added_at AS addedAt, updated_at AS updatedAt
           FROM upcs WHERE product_id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids)
    : [];
  const upcsByProduct = new Map();
  for (const u of upcRows) {
    if (!upcsByProduct.has(u.productId)) upcsByProduct.set(u.productId, []);
    upcsByProduct.get(u.productId).push({
      upc: u.upc, flavour: u.flavour || null,
      addedAt: u.addedAt || null, updatedAt: u.updatedAt || null,
    });
  }
  const products = rows.map(p => ({
    ...p,
    upcs: (upcsByProduct.get(p.id) || []).sort((a, b) => a.upc.localeCompare(b.upc)),
  }));
  return { products, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Lightweight product search for autocomplete pickers — no UPC expansion.
function searchProductsSimple(q, { limit = 20, curatedOnly = false } = {}) {
  const whereParts = [];
  const whereParams = [];
  if (curatedOnly) { whereParts.push('p.curated = 1'); }
  if (q) {
    whereParts.push(
      `(p.name LIKE ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM upcs u WHERE u.product_id = p.id AND u.upc LIKE ?))`
    );
    whereParams.push(`%${q}%`, `%${q}%`);
  }
  const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
  return db.prepare(
    `SELECT p.id, p.name, p.abv, p.volume_ml AS volumeMl, p.curated,
            (SELECT COUNT(*) FROM upcs u WHERE u.product_id = p.id) AS upcCount
       FROM products p ${where}
      ORDER BY p.curated DESC, p.name COLLATE NOCASE
      LIMIT ?`
  ).all(...whereParams, limit);
}

// Full details for a single product (including UPCs) for merge preview etc.
function getProductWithUpcs(id) {
  const prod = stmts.getProductById.get(id);
  if (!prod) return null;
  const upcs = stmts.getUpcsByProduct.all(id).map(u => ({
    upc: u.upc, flavour: u.flavour || null,
    addedAt: u.addedAt || null, updatedAt: u.updatedAt || null,
  })).sort((a, b) => a.upc.localeCompare(b.upc));
  return { ...prod, upcs };
}

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
  // Only adopt the existing row when it is itself curated. Otherwise a curated
  // edit could silently rewrite a CSV-imported entry; instead, branch a fresh
  // curated product alongside it. Same name is fine — UNIQUE was dropped.
  if (prod && !prod.curated) prod = null;
  if (!prod) {
    prod = {
      id: entry.makeProductId(),
      name: entry.name,
      abv: entry.abv,
      volumeMl: entry.volumeMl,
      category: null,
      curated: 1,
      createdAt: now,
      updatedAt: now,
    };
    stmts.insertProduct.run(prod);
  } else {
    prod.abv = entry.abv;
    if (entry.volumeMl != null) prod.volumeMl = entry.volumeMl;
    prod.curated = 1;
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

function listSubmissionsPaginated({ q = '', page = 1, limit = 100 } = {}) {
  const safe = Math.max(1, Math.floor(page));
  const lim  = Math.min(Math.max(1, Math.floor(limit)), 500);
  const off  = (safe - 1) * lim;
  let rows, total;
  if (q) {
    const pat = `%${q}%`;
    rows  = db.prepare(`
      SELECT upc, name, abv, volume_ml AS volumeMl, flavour,
             from_name AS [from], people, user_agent AS ua, received_at AS receivedAt
        FROM submissions
       WHERE name LIKE ? OR upc LIKE ? OR from_name LIKE ? OR people LIKE ?
       ORDER BY received_at DESC
       LIMIT ? OFFSET ?
    `).all(pat, pat, pat, pat, lim, off);
    total = db.prepare(`
      SELECT COUNT(*) AS n FROM submissions
       WHERE name LIKE ? OR upc LIKE ? OR from_name LIKE ? OR people LIKE ?
    `).get(pat, pat, pat, pat).n;
  } else {
    rows  = db.prepare(`
      SELECT upc, name, abv, volume_ml AS volumeMl, flavour,
             from_name AS [from], people, user_agent AS ua, received_at AS receivedAt
        FROM submissions ORDER BY received_at DESC LIMIT ? OFFSET ?
    `).all(lim, off);
    total = stmts.countSubmissions.get().n;
  }
  return {
    entries: rows.map(rehydrateSubmission),
    total,
    page:  safe,
    limit: lim,
    pages: Math.max(1, Math.ceil(total / lim)),
  };
}

function appendRejected(upc, reason) {
  stmts.upsertRejected.run(upc, reason || null, new Date().toISOString());
}
function listRejected() { return stmts.listRejected.all(); }
function countRejected() { return stmts.countRejected.get().n; }
function isRejected(upc) { return !!stmts.isRejected.get(upc); }

// ---- session DAO -------------------------------------------------------

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
  const publicId = genSessionId();
  const now = nowIso();
  const name = (payload.name || '').toString().trim().slice(0, 60) || defaultSessionName(now);
  stmts.insertSession.run({
    id,
    publicId,
    name,
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
      const presetShape = effectivePresetValues(p);
      if (!presetShape) continue;
      stmts.upsertPreset.run({
        sessionId:      id,
        presetKey:      String(p.presetKey).slice(0, 60),
        name:           String(p.name).slice(0, 40),
        volumeMl:       presetShape.volumeMl,
        abv:            presetShape.abv,
        kcalPer100ml:   p.kcalPer100ml == null ? null : Number(p.kcalPer100ml),
        lastUsedAt:     p.lastUsedAt == null ? null : Number(p.lastUsedAt),
        inputKind:      presetShape.inputKind,
        componentsJson: presetShape.componentsJson,
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
  s.people    = stmts.listPeople.all(id);
  s.presets   = stmts.listPresets.all(id).map(rowWithPresetComponents);
  s.drinks    = stmts.listDrinks.all(id).map(rowWithComponents);
  s.events    = stmts.listEvents.all(id).map(e => ({
    ...e,
    data: e.data ? JSON.parse(e.data) : {},
  }));
  s.comments  = stmts.listComments.all(id);
  s.reactions = stmts.listReactionsForSession.all(id);
  return s;
}

function getReportFull(publicId) {
  const meta = stmts.getSessionByPublicId.get(publicId);
  if (!meta) return null;
  const s = getSessionFull(meta.id);
  if (!s) return null;
  delete s.id;
  return s;
}

function getPrivateSessionIdForReport(publicId) {
  const meta = stmts.getSessionByPublicId.get(publicId);
  return meta ? meta.id : null;
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
  const shape = effectivePresetValues(p);
  if (!shape) {
    const err = new Error('preset volume and ABV must be valid numbers');
    err.status = 400;
    throw err;
  }
  stmts.upsertPreset.run({
    sessionId,
    presetKey:      String(p.presetKey).slice(0, 60),
    name:           String(p.name).slice(0, 40),
    volumeMl:       shape.volumeMl,
    abv:            shape.abv,
    kcalPer100ml:   p.kcalPer100ml == null ? null : Number(p.kcalPer100ml),
    lastUsedAt:     p.lastUsedAt == null ? null : Number(p.lastUsedAt),
    inputKind:      shape.inputKind,
    componentsJson: shape.componentsJson,
  });
  stmts.touchSession.run(nowIso(), sessionId);
});
function upsertPreset(sessionId, p) {
  upsertPresetTx(sessionId, p);
  return rowWithPresetComponents(stmts.getPreset.get(sessionId, p.presetKey));
}

// "Edit all of this type": mutates the preset row AND every drink linked to it.
// Cocktail presets cascade their full component list onto every linked drink so
// they stay editable as cocktails after the cascade.
const updatePresetCascadeTx = db.transaction((sessionId, presetKey, fields) => {
  const cur = rowWithPresetComponents(stmts.getPreset.get(sessionId, presetKey));
  if (!cur) return null;
  const merged = {
    name:       fields.name      != null ? fields.name : cur.name,
    volumeMl:   fields.volumeMl  != null ? fields.volumeMl : cur.volumeMl,
    abv:        fields.abv       != null ? fields.abv : cur.abv,
    inputKind:  fields.inputKind != null ? fields.inputKind : cur.inputKind,
    components: fields.components != null ? fields.components : cur.components,
  };
  const shape = effectivePresetValues(merged);
  if (!shape) return cur;
  const next = {
    sessionId,
    presetKey,
    name:           String(merged.name).slice(0, 40),
    volumeMl:       shape.volumeMl,
    abv:            shape.abv,
    inputKind:      shape.inputKind,
    componentsJson: shape.componentsJson,
  };
  stmts.updatePresetCore.run(next);
  stmts.updateDrinksByPresetStmt.run(next);
  stmts.touchSession.run(nowIso(), sessionId);
  return rowWithPresetComponents(stmts.getPreset.get(sessionId, presetKey));
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

function parseDrinkComponents(row) {
  if (!row || !row.componentsJson) return [];
  try {
    const parsed = JSON.parse(row.componentsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function rowWithComponents(row) {
  if (!row) return row;
  const components = parseDrinkComponents(row);
  const { componentsJson, ...rest } = row;
  return { ...rest, components };
}

function rowWithPresetComponents(row) {
  if (!row) return row;
  const components = parseDrinkComponents(row);
  const { componentsJson, ...rest } = row;
  return { ...rest, inputKind: rest.inputKind || 'whole', components };
}

// Mirror of effectiveDrinkValues for presets. Cocktail presets derive their
// volume/ABV from components; whole presets use the supplied values.
// Returns null when the values can't form a valid preset.
function effectivePresetValues(preset) {
  const inputKind = preset?.inputKind === 'cocktail' ? 'cocktail' : 'whole';
  const components = inputKind === 'cocktail' ? normalizeComponents(preset?.components) : [];
  if (inputKind === 'cocktail') {
    if (!components.length) return null;
    const volumeMl = components.reduce((sum, c) => sum + c.volumeMl, 0);
    const ethanolMl = components.reduce((sum, c) => sum + c.volumeMl * c.abv / 100, 0);
    if (!(volumeMl > 0)) return null;
    return {
      inputKind,
      components,
      volumeMl: +volumeMl.toFixed(2),
      abv: +(ethanolMl / volumeMl * 100).toFixed(2),
      componentsJson: JSON.stringify(components),
    };
  }
  const vol = Number(preset?.volumeMl);
  const abv = Number(preset?.abv);
  if (!Number.isFinite(vol) || vol <= 0) return null;
  if (!Number.isFinite(abv) || abv < 0 || abv > 100) return null;
  return {
    inputKind: 'whole',
    components: [],
    volumeMl: +vol.toFixed(2),
    abv: +abv.toFixed(2),
    componentsJson: null,
  };
}

function normalizeComponents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => ({
    name: String(c?.name || 'Component').trim().slice(0, 60) || 'Component',
    volumeMl: +Number(c?.volumeMl).toFixed(2),
    abv: +Number(c?.abv).toFixed(2),
    upc: c?.upc ? String(c.upc).replace(/\D+/g, '').slice(0, 32) : null,
  })).filter(c => Number.isFinite(c.volumeMl) && c.volumeMl > 0 && Number.isFinite(c.abv) && c.abv >= 0 && c.abv <= 100);
}

function effectiveDrinkValues(drink, fallback = {}) {
  const inputKind = drink.inputKind === 'cocktail' ? 'cocktail' : 'whole';
  const components = inputKind === 'cocktail' ? normalizeComponents(drink.components) : [];
  if (components.length) {
    const volumeMl = components.reduce((sum, c) => sum + c.volumeMl, 0);
    const ethanolMl = components.reduce((sum, c) => sum + c.volumeMl * c.abv / 100, 0);
    return {
      inputKind,
      components,
      volumeMl: +volumeMl.toFixed(2),
      abv: +(volumeMl > 0 ? ethanolMl / volumeMl * 100 : 0).toFixed(2),
      componentsJson: JSON.stringify(components),
    };
  }
  const volumeMl = drink.volumeMl != null ? Number(drink.volumeMl) : Number(fallback.volumeMl);
  const abv = drink.abv != null ? Number(drink.abv) : Number(fallback.abv);
  return {
    inputKind: 'whole',
    components: [],
    volumeMl: +volumeMl.toFixed(2),
    abv: +abv.toFixed(2),
    componentsJson: null,
  };
}

function drinkEventData(person, drink) {
  return {
    personName: person?.name || '',
    drinkName:  drink.name || '',
    flavour:    drink.flavour || null,
    volumeMl:   drink.volumeMl,
    abv:        drink.abv,
    inputKind:  drink.inputKind || 'whole',
    components: drink.components || [],
  };
}

function insertSessionEvent({ sessionId, type, personId = null, drinkId = null, data = {}, t = Date.now(), createdAt = nowIso() }) {
  const info = stmts.insertEvent.run({
    sessionId,
    type,
    personId,
    drinkId,
    data: JSON.stringify(data || {}),
    t,
    createdAt,
  });
  return info.lastInsertRowid;
}

const addDrinkTx = db.transaction((sessionId, drink) => {
  // Verify person belongs to this session.
  const person = stmts.getPerson.get(drink.personId);
  if (!person || person.sessionId !== sessionId) {
    throw Object.assign(new Error('person not in session'), { status: 400 });
  }
  const now = nowIso();
  const effective = effectiveDrinkValues(drink);
  if (!Number.isFinite(effective.volumeMl) || effective.volumeMl <= 0 || !Number.isFinite(effective.abv) || effective.abv < 0 || effective.abv > 100) {
    throw Object.assign(new Error('invalid drink values'), { status: 400 });
  }
  const savedDrink = {
    personId:  drink.personId,
    presetKey: drink.presetKey || null,
    name:      String(drink.name || '').slice(0, 60) || `${Math.round(effective.volumeMl)} ml · ${effective.abv}%`,
    flavour:   drink.flavour ? String(drink.flavour).slice(0, 60) : null,
    volumeMl:  effective.volumeMl,
    abv:       effective.abv,
    inputKind: effective.inputKind,
    components: effective.components,
    componentsJson: effective.componentsJson,
    t:         drink.t == null ? Date.now() : Number(drink.t),
    createdAt: now,
  };
  const info = stmts.insertDrink.run({ sessionId, ...savedDrink });
  insertSessionEvent({
    sessionId,
    type: 'drink_added',
    personId: drink.personId,
    drinkId: info.lastInsertRowid,
    data: drinkEventData(person, savedDrink),
    t: savedDrink.t,
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
  return rowWithComponents(stmts.getDrink.get(id));
}

function updateDrink(sessionId, drinkId, fields) {
  const cur = stmts.getDrink.get(drinkId);
  if (!cur || cur.sessionId !== sessionId) return null;
  const effective = effectiveDrinkValues(fields, cur);
  if (!Number.isFinite(effective.volumeMl) || effective.volumeMl <= 0 || !Number.isFinite(effective.abv) || effective.abv < 0 || effective.abv > 100) return null;
  const next = {
    id: drinkId,
    name:      fields.name     != null ? String(fields.name).slice(0, 60) : cur.name,
    flavour:   fields.flavour !== undefined
                  ? (fields.flavour ? String(fields.flavour).slice(0, 60) : null)
                  : (cur.flavour || null),
    volumeMl:  effective.volumeMl,
    abv:       effective.abv,
    inputKind: effective.inputKind,
    componentsJson: effective.componentsJson,
    // Editing a single drink unlinks it from its preset (matches frontend
    // semantics: "all of this type" goes through updatePresetCascade).
    presetKey: fields.unlinkPreset === true ? null : (cur.presetKey || null),
  };
  stmts.updateDrinkStmt.run(next);
  stmts.touchSession.run(nowIso(), sessionId);
  return rowWithComponents(stmts.getDrink.get(drinkId));
}

function removeDrink(sessionId, drinkId) {
  const cur = stmts.getDrink.get(drinkId);
  if (!cur || cur.sessionId !== sessionId) return false;
  const person = stmts.getPerson.get(cur.personId);
  const now = nowIso();
  insertSessionEvent({
    sessionId,
    type: 'drink_removed',
    personId: cur.personId,
    drinkId,
    data: drinkEventData(person, rowWithComponents(cur)),
    t: Date.now(),
    createdAt: now,
  });
  stmts.deleteDrinkStmt.run(drinkId);
  stmts.touchSession.run(now, sessionId);
  return true;
}

const addCommentTx = db.transaction((sessionId, comment) => {
  if (comment.personId != null) {
    const person = stmts.getPerson.get(comment.personId);
    if (!person || person.sessionId !== sessionId) {
      throw Object.assign(new Error('person not in session'), { status: 400 });
    }
  }
  const now = nowIso();
  const info = stmts.insertComment.run({
    sessionId,
    personId:   comment.personId || null,
    authorName: comment.authorName || null,
    text:       String(comment.text || '').trim().slice(0, 500),
    t:          comment.t == null ? Date.now() : Number(comment.t),
    createdAt:  now,
  });
  stmts.touchSession.run(now, sessionId);
  return info.lastInsertRowid;
});
function addComment(sessionId, comment) {
  const id = addCommentTx(sessionId, comment);
  return stmts.getComment.get(id);
}

function updateComment(sessionId, commentId, fields) {
  const cur = stmts.getComment.get(commentId);
  if (!cur || cur.sessionId !== sessionId) return null;
  const text = fields.text != null ? String(fields.text).trim().slice(0, 500) : cur.text;
  const t = fields.t != null ? Number(fields.t) : cur.t;
  stmts.updateCommentStmt.run(text, t, commentId);
  stmts.touchSession.run(nowIso(), sessionId);
  return stmts.getComment.get(commentId);
}

function removeComment(sessionId, commentId) {
  const cur = stmts.getComment.get(commentId);
  if (!cur || cur.sessionId !== sessionId) return false;
  stmts.deleteCommentStmt.run(commentId);
  stmts.touchSession.run(nowIso(), sessionId);
  return true;
}

function toggleReaction(sessionId, commentId, { personId, deviceId, authorName, emoji }) {
  const comment = stmts.getComment.get(commentId);
  if (!comment || comment.sessionId !== sessionId) return false;

  const params = { commentId, personId: personId || null, deviceId: deviceId || null, authorName: authorName || null, emoji };
  
  // Try to delete first. If 0 changes, then insert.
  const delInfo = stmts.deleteReaction.run(params);
  if (delInfo.changes === 0) {
    stmts.insertReaction.run({ ...params, createdAt: nowIso() });
  }

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


function ensureBackupDir() {
  const dir = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupLabel(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function backupName(label = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = backupLabel(label);
  return `data-${stamp}${suffix ? '-' + suffix : ''}.db`;
}

async function createBackup({ label = '' } = {}) {
  const dir = ensureBackupDir();
  const filename = backupName(label);
  const file = path.join(dir, filename);
  await db.backup(file);
  const st = fs.statSync(file);
  return {
    filename,
    size: st.size,
    createdAt: st.birthtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
  };
}

function listBackups() {
  const dir = ensureBackupDir();
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isFile() && /^data-.*\.db$/.test(d.name))
    .map(d => {
      const file = path.join(dir, d.name);
      const st = fs.statSync(file);
      return {
        filename: d.name,
        size: st.size,
        createdAt: st.birthtime.toISOString(),
        updatedAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.filename.localeCompare(a.filename));
}

function backupPath(filename) {
  if (typeof filename !== 'string' || !/^data-[A-Za-z0-9._-]+\.db$/.test(filename)) return null;
  const dir = ensureBackupDir();
  const file = path.join(dir, filename);
  const rel = path.relative(dir, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

// ---- BC Liquor CSV import (one-shot bootstrap) ---------------------------
//
// Reads the monthly BC Liquor price-list CSV from the repo root and seeds
// the products+upcs tables. Idempotent: skips rows whose UPC is already
// present or rejected, so re-runs are cheap no-ops. Within one run, SKUs
// that share (name, volume, abv, category) collapse onto the same product
// so their UPCs hang off a single brand row.
//
// Once production has run this once, the CSV asset can be removed from the
// repo entirely — the data lives in data.db from that point on.

const BC_CSV_NAMES = [
  'bc_liquor_store_product_price_list_december_2025.csv',
];

function findBcLiquorCsv() {
  const searchDirs = [path.join(__dirname, '..'), DATA_DIR, __dirname];
  for (const dir of searchDirs) {
    for (const name of BC_CSV_NAMES) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function parseBcCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"')  { inQuotes = true; i++; continue; }
    if (ch === ',')  { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; i++; continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// BC Liquor stores names ALL-CAPS; title-case for display.
function tidyCsvName(s) {
  const cleaned = (s || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

function csvMakeProductId(name) {
  const slug = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'p';
  // 8 hex chars (32 bits) — collision probability is negligible across the
  // ~7k CSV rows in one batch.
  const hex = crypto.randomBytes(4).toString('hex');
  return `p_${slug}_${hex}`;
}

function importBcLiquorCsvIfPresent() {
  const file = findBcLiquorCsv();
  if (!file) return;

  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { console.warn(`db: failed to read ${file}:`, e.message); return; }

  const rows = parseBcCsv(text);
  if (rows.length < 2) return;

  const header = rows[0].map(h => h.trim());
  const iName = header.indexOf('PRODUCT_LONG_NAME');
  const iUpc  = header.indexOf('PRODUCT_BASE_UPC_NO');
  const iLit  = header.indexOf('PRODUCT_LITRES_PER_CONTAINER');
  const iAbv  = header.indexOf('PRODUCT_ALCOHOL_PERCENT');
  const iCat  = header.indexOf('ITEM_CATEGORY_NAME');
  if (iName < 0 || iUpc < 0 || iLit < 0 || iAbv < 0) {
    console.warn('db: BC CSV header missing expected columns; skipping import');
    return;
  }

  const existingUpcs = new Set(stmts.listUpcs.all().map(u => u.upc));
  const rejectedUpcs = new Set(stmts.listRejected.all().map(r => r.upc));

  // Dedupe inside one run by (name|vol|abv|category). Re-runs find these
  // again via name lookup so we don't make stray duplicate products.
  const byKey = new Map();
  for (const p of stmts.listProducts.all()) {
    if (p.curated) continue;
    byKey.set(`${p.name.toLowerCase()}|${p.volumeMl}|${p.abv}|${(p.category || '').toLowerCase()}`, p);
  }

  let importedProducts = 0;
  let importedUpcs = 0;
  let skippedDupUpc = 0;
  let skippedRejected = 0;
  let skippedBadRow = 0;

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const upc = (row[iUpc] || '').trim();
      if (!upc || !/^\d{6,20}$/.test(upc)) { skippedBadRow++; continue; }
      if (existingUpcs.has(upc)) { skippedDupUpc++; continue; }
      if (rejectedUpcs.has(upc))  { skippedRejected++; continue; }
      const litres = parseFloat(row[iLit]);
      const abv    = parseFloat(row[iAbv]);
      if (!isFinite(litres) || !isFinite(abv) || litres <= 0 || abv < 0 || abv > 100) {
        skippedBadRow++; continue;
      }
      const name = tidyCsvName(row[iName] || '');
      if (!name) { skippedBadRow++; continue; }
      const volumeMl = +(litres * 1000).toFixed(2);
      const abvNorm = +abv.toFixed(2);
      const category = (row[iCat] || '').trim() || null;

      const key = `${name.toLowerCase()}|${volumeMl}|${abvNorm}|${(category || '').toLowerCase()}`;
      let prod = byKey.get(key);
      if (!prod) {
        prod = {
          id: csvMakeProductId(name),
          name,
          abv: abvNorm,
          volumeMl,
          category,
          curated: 0,
          createdAt: now,
          updatedAt: now,
        };
        stmts.insertProduct.run(prod);
        byKey.set(key, prod);
        importedProducts++;
      }
      stmts.upsertUpc.run({
        upc,
        productId: prod.id,
        flavour: null,
        addedAt: now,
        updatedAt: null,
      });
      existingUpcs.add(upc);
      importedUpcs++;
    }
  });

  tx();

  // Log only when there was actual work to do. Re-runs against an already-
  // imported DB stay silent so the boot logs don't get noisy.
  if (importedProducts || importedUpcs) {
    console.log(
      `db: BC CSV import — ${importedProducts} products, ${importedUpcs} UPCs ` +
      `(skipped ${skippedDupUpc} already-known UPCs, ${skippedRejected} rejected, ${skippedBadRow} unusable rows)`
    );
  }
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
        category:  null,
        curated:   1,
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
  listProductsPaginated, searchProductsSimple, getProductWithUpcs,
  insertProduct, updateProduct, deleteProduct,

  // upcs
  listUpcs, getUpc, getUpcsByProduct,
  upsertUpc, deleteUpc,

  // catalogue
  joinedCatalogue,

  // legacy adapter
  upsertCurated,

  // submissions
  appendSubmission, listSubmissions, countSubmissions, listSubmissionsPaginated,

  // rejected
  appendRejected, listRejected, countRejected, isRejected,

  // sessions
  genSessionId,
  createSession, getSessionFull, getReportFull, getPrivateSessionIdForReport,
  getSessionMeta, listSessions, deleteSession,
  renameSession, setBenchmark, touchSession,
  addPerson, renamePerson, removePerson,
  upsertPreset, updatePresetCascade, touchPreset, removePreset,
  addDrink, updateDrink, removeDrink,
  addComment, updateComment, removeComment, toggleReaction,

  // backups
  createBackup, listBackups, backupPath,

  // bootstrap
  migrateFromJsonIfNeeded,
  importBcLiquorCsvIfPresent,
};
