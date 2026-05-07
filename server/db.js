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

  // bootstrap
  migrateFromJsonIfNeeded,
};
