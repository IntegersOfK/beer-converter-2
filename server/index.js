// Beer Converter backend.
//
// Three surfaces in one zero-dependency Node process:
//
//   1. Public submit endpoint
//        POST /submit           — accept { upc, name, abv, volumeMl? }
//
//   2. Public catalogue
//        GET  /catalog.json     — JOINed product + upc dataset, fetched at
//                                 app load time
//
//   3. Curation admin (unique path; user runs it behind their own protection)
//        GET  ${ADMIN_PATH}/                  — single-page admin GUI
//        GET  ${ADMIN_PATH}/api/queue         — pending submissions + suggestions
//        GET  ${ADMIN_PATH}/api/products      — list products + their upcs
//        POST ${ADMIN_PATH}/api/product       — upsert one product
//        DEL  ${ADMIN_PATH}/api/product/:id   — delete product + cascade upcs
//        POST ${ADMIN_PATH}/api/upc           — upsert one upc → product link
//        DEL  ${ADMIN_PATH}/api/upc/:upc      — detach a UPC
//        POST ${ADMIN_PATH}/api/curated       — LEGACY adapter (writes new model)
//        DEL  ${ADMIN_PATH}/api/curated/:upc  — LEGACY adapter
//        POST ${ADMIN_PATH}/api/reject        — mark a UPC as rejected
//        POST ${ADMIN_PATH}/api/deploy        — git pull, data files preserved
//
// Run:
//   node server/index.js                         # listens on $PORT or 8787
//   ADMIN_PATH=/_my_admin_xyz node server/index.js
//
// Files written next to this one (override DATA_DIR to relocate):
//   submissions.jsonl    — append-only raw submissions from the app
//   products.json        — [{ id, name, abv, volumeMl? }]
//   upcs.json            — [{ upc, productId, flavour? }]
//   rejected.jsonl       — append-only log of UPCs marked junk
//   curated.legacy.json  — pre-migration curated.json, kept for rollback only

const http       = require('node:http');
const fs         = require('node:fs');
const path       = require('node:path');
const { execFile, spawn } = require('node:child_process');

const REPO_ROOT         = path.join(__dirname, '..');
// systemd unit to restart after a successful deploy. Set RESTART_ON_DEPLOY=0
// to disable (e.g. when running outside systemd).
const SYSTEMD_UNIT      = process.env.SYSTEMD_UNIT || 'bc-node.service';
const RESTART_ON_DEPLOY = process.env.RESTART_ON_DEPLOY !== '0';

const PORT           = Number(process.env.PORT) || 8787;
const DATA_DIR       = process.env.DATA_DIR || __dirname;
const SUBMIT_LOG     = path.join(DATA_DIR, 'submissions.jsonl');
const PRODUCTS       = path.join(DATA_DIR, 'products.json');
const UPCS           = path.join(DATA_DIR, 'upcs.json');
const REJECTED       = path.join(DATA_DIR, 'rejected.jsonl');
// Legacy file paths — only read at boot to drive the one-shot migration.
const CURATED_LEGACY    = path.join(DATA_DIR, 'curated.json');
const CURATED_ARCHIVED  = path.join(DATA_DIR, 'curated.legacy.json');
const ADMIN_DIR  = path.join(__dirname, 'admin');
const ADMIN_PATH = (process.env.ADMIN_PATH || '/_admin_8f3k9qz4').replace(/\/+$/, '');
const MAX_BODY   = 16 * 1024;   // 16 KB — products endpoint can carry a whole row

// CORS allowlist for /submit + /catalog.json (the admin path is same-origin only).
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGIN ||
  'https://bc.ajwest.ca,http://localhost:8080,http://127.0.0.1:8080'
).split(',').map(s => s.trim()).filter(Boolean);

function corsHeadersFor(reqOrigin) {
  const allow =
    ALLOW_ORIGINS.includes('*') ? '*' :
    (reqOrigin && ALLOW_ORIGINS.includes(reqOrigin)) ? reqOrigin :
    null;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

function send(res, status, body, reqOrigin) {
  const isJson = body && typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain',
    ...corsHeadersFor(reqOrigin),
  });
  res.end(isJson ? JSON.stringify(body) : (body == null ? '' : String(body)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// --- file helpers ----------------------------------------------------------

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch (e) {
    console.warn(`Failed to read ${file}:`, e.message);
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

function appendJsonl(file, obj) {
  return new Promise((resolve, reject) => {
    fs.appendFile(file, JSON.stringify(obj) + '\n', (err) => err ? reject(err) : resolve());
  });
}

// Atomic-ish write: temp file + rename. Avoids leaving curated.json half-written
// if the process dies mid-save.
function writeJsonAtomic(file, obj) {
  return new Promise((resolve, reject) => {
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(obj, null, 2), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, file, (err2) => err2 ? reject(err2) : resolve());
    });
  });
}

// --- normalisation ---------------------------------------------------------

function normaliseUpc(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, '') : '';
}

function isValidUpc(s) {
  return /^\d{6,20}$/.test(s);
}

function normaliseName(s, max = 80) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length === 0 || t.length > max ? '' : t;
}

function normaliseAbv(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return +n.toFixed(2);
}

function normaliseVolume(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 100000) return null;
  return +n.toFixed(2);
}

function normaliseFlavour(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length === 0 ? null : t.slice(0, 60);
}

// --- product + upc storage -------------------------------------------------
//
// products.json: array of { id, name, abv, volumeMl?, createdAt, updatedAt }
// upcs.json:     array of { upc, productId, flavour?, addedAt, updatedAt? }
//
// Product `id` is a slug + 4-char random hex so renames are cheap (no UPC
// rows touched). UPCs reference products by id, never by name.

function readProducts() { return readJsonSafe(PRODUCTS, []); }
function readUpcs()     { return readJsonSafe(UPCS, []); }

function makeProductId(name) {
  const slug = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'p';
  // 4 random hex chars — collision-resistant enough for hand-curated data.
  const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `p_${slug}_${hex}`;
}

function joinedCatalogue() {
  const products = readProducts();
  const upcs     = readUpcs();
  const byId     = new Map(products.map(p => [p.id, p]));
  const out = [];
  for (const u of upcs) {
    const p = byId.get(u.productId);
    if (!p) continue;     // orphaned UPC — skip silently
    const entry = {
      upc:       u.upc,
      productId: p.id,
      name:      p.name,
      abv:       p.abv,
    };
    if (p.volumeMl != null) entry.volumeMl = p.volumeMl;
    if (u.flavour)          entry.flavour  = u.flavour;
    out.push(entry);
  }
  return out;
}

// --- migration (one-shot at boot) ------------------------------------------
//
// If products.json exists, we're already migrated and skip. Otherwise read
// curated.json (legacy flat shape), group by name into products, write the
// two new files, and rename the legacy file out of the way for rollback.

function migrateIfNeeded() {
  if (fs.existsSync(PRODUCTS) || fs.existsSync(UPCS)) return;

  const legacy = readJsonSafe(CURATED_LEGACY, null);
  if (!Array.isArray(legacy)) {
    fs.writeFileSync(PRODUCTS, '[]\n');
    fs.writeFileSync(UPCS,     '[]\n');
    console.log('Migration: no legacy curated.json — initialised empty products.json + upcs.json.');
    return;
  }

  console.log(`Migration: converting ${legacy.length} legacy curated entries…`);
  const productsByName = new Map();
  const upcs = [];
  let mismatchAbv = 0, mismatchVol = 0;

  for (const c of legacy) {
    if (!c || typeof c.name !== 'string' || !c.upc) continue;
    const name = c.name.trim();
    if (!name) continue;
    const upc  = normaliseUpc(c.upc);
    if (!isValidUpc(upc)) continue;
    const abv  = normaliseAbv(c.abv);
    if (abv == null) continue;
    const vol  = normaliseVolume(c.volumeMl);

    let prod = productsByName.get(name);
    if (!prod) {
      prod = {
        id:        makeProductId(name),
        name,
        abv,
        volumeMl:  vol,
        createdAt: c.updatedAt || new Date().toISOString(),
        updatedAt: c.updatedAt || new Date().toISOString(),
      };
      productsByName.set(name, prod);
    } else {
      // Pick first-encountered as canonical; warn on disagreement.
      if (Math.abs(abv - prod.abv) > 0.01) mismatchAbv++;
      if (vol != null && prod.volumeMl != null && Math.abs(vol - prod.volumeMl) > 0.01) mismatchVol++;
      // If the canonical was missing volumeMl and this row has one, adopt it.
      if (prod.volumeMl == null && vol != null) prod.volumeMl = vol;
    }

    upcs.push({
      upc,
      productId: prod.id,
      flavour:   null,
      addedAt:   c.updatedAt || new Date().toISOString(),
    });
  }

  const products = [...productsByName.values()];
  fs.writeFileSync(PRODUCTS, JSON.stringify(products, null, 2));
  fs.writeFileSync(UPCS,     JSON.stringify(upcs,     null, 2));

  // Move legacy file aside for easy rollback.
  try { fs.renameSync(CURATED_LEGACY, CURATED_ARCHIVED); } catch {}

  console.log(`Migration: ${products.length} products, ${upcs.length} upcs written.`);
  if (mismatchAbv) console.warn(`  ${mismatchAbv} ABV mismatches — kept first-encountered value.`);
  if (mismatchVol) console.warn(`  ${mismatchVol} volume mismatches — kept first-encountered value.`);
}

function normaliseSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) return null;
  const abv = Number(raw.abv);
  if (!Number.isFinite(abv) || abv < 0 || abv > 100) return null;
  const out = { name, abv: +abv.toFixed(2), receivedAt: new Date().toISOString() };
  // upc is optional — non-UPC drink-log events are welcome for aggregate data.
  const upc = normaliseUpc(raw.upc || '');
  if (upc && isValidUpc(upc)) out.upc = upc;
  if (raw.volumeMl != null) {
    const v = Number(raw.volumeMl);
    if (Number.isFinite(v) && v > 0 && v < 100000) out.volumeMl = +v.toFixed(2);
  }
  if (typeof raw.from === 'string' && raw.from.trim()) {
    out.from = raw.from.trim().slice(0, 40);
  }
  if (Array.isArray(raw.people) && raw.people.length) {
    const ps = raw.people
      .filter(p => typeof p === 'string' && p.trim())
      .map(p => p.trim().slice(0, 40))
      .slice(0, 20);
    if (ps.length) out.people = ps;
  }
  return out;
}

// --- queue construction ----------------------------------------------------
// Pending = UPCs that have submissions but are NOT already linked to a product
// and NOT rejected. Aggregate per UPC so a popular product collapses into one
// card.
function buildQueue() {
  const submissions = readJsonl(SUBMIT_LOG);
  const curated     = joinedCatalogue();   // legacy shape: flat per-UPC
  const rejected    = readJsonl(REJECTED);

  const curatedByUpc = new Map(curated.map(c => [c.upc, c]));
  const rejectedSet  = new Set(rejected.map(r => r.upc));

  const byUpc = new Map();
  for (const s of submissions) {
    if (!s || !s.upc) continue;
    if (curatedByUpc.has(s.upc) || rejectedSet.has(s.upc)) continue;
    let bucket = byUpc.get(s.upc);
    if (!bucket) {
      bucket = {
        upc: s.upc, count: 0,
        names: new Map(), abvs: new Map(), volumes: new Map(),
        firstSeen: s.receivedAt, lastSeen: s.receivedAt,
      };
      byUpc.set(s.upc, bucket);
    }
    bucket.count++;
    bucket.names.set(s.name, (bucket.names.get(s.name) || 0) + 1);
    const abvKey = String(s.abv);
    bucket.abvs.set(abvKey, (bucket.abvs.get(abvKey) || 0) + 1);
    if (s.volumeMl != null) {
      const volKey = String(s.volumeMl);
      bucket.volumes.set(volKey, (bucket.volumes.get(volKey) || 0) + 1);
    }
    if (s.receivedAt < bucket.firstSeen) bucket.firstSeen = s.receivedAt;
    if (s.receivedAt > bucket.lastSeen)  bucket.lastSeen  = s.receivedAt;
  }

  // Materialise + suggest. Sort entries by last-seen desc so newest bubbles up.
  const entries = [...byUpc.values()].map(b => {
    const names   = [...b.names.entries()].sort((a, c) => c[1] - a[1]);
    const abvs    = [...b.abvs.entries()].sort((a, c) => c[1] - a[1]);
    const volumes = [...b.volumes.entries()].sort((a, c) => c[1] - a[1]);
    return {
      upc:         b.upc,
      count:       b.count,
      firstSeen:   b.firstSeen,
      lastSeen:    b.lastSeen,
      names:       names.map(([name, n])     => ({ name, n })),
      abvs:        abvs.map(([abv, n])       => ({ abv: +abv, n })),
      volumes:     volumes.map(([vol, n])    => ({ volumeMl: +vol, n })),
      suggestions: suggestMatches(names[0]?.[0] || '', curated),
    };
  });
  entries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));

  return { pending: entries, curated, rejectedCount: rejected.length };
}

// Token-set Jaccard on lowercased word tokens. Cheap, surprisingly good for
// "White Claw Mango" ↔ "White Claw Black Cherry" kind of matches. Suggestions
// are deduped by curated name — clicking one renames to that exact string,
// which is how the admin merges variants into the same display product.
function suggestMatches(name, curated) {
  if (!name || !curated.length) return [];
  const a = tokenSet(name);
  if (!a.size) return [];
  const bestByName = new Map();
  for (const c of curated) {
    const b = tokenSet(c.name);
    if (!b.size) continue;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    const j = union ? inter / union : 0;
    if (j <= 0.25) continue;
    const prev = bestByName.get(c.name);
    if (!prev || j > prev.score) {
      bestByName.set(c.name, { score: +j.toFixed(3), name: c.name });
    }
  }
  return [...bestByName.values()].sort((x, y) => y.score - x.score).slice(0, 4);
}

function tokenSet(s) {
  return new Set(
    String(s).toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
  );
}

// --- static admin ----------------------------------------------------------

function serveAdminFile(req, res, relPath) {
  const safe = relPath.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
  const file = safe ? path.join(ADMIN_DIR, safe) : path.join(ADMIN_DIR, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { send(res, 404, 'admin asset not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8'
             : ext === '.css'  ? 'text/css; charset=utf-8'
             : ext === '.js'   ? 'application/javascript; charset=utf-8'
             : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// --- request router --------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url    = req.url || '/';

  // Preflight for any CORS-enabled route.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(origin));
    res.end();
    return;
  }

  // Public health
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    send(res, 200, { ok: true, adminPath: ADMIN_PATH }, origin);
    return;
  }

  // Public catalogue (JOINed product + upc rows, flat shape).
  if (req.method === 'GET' && url === '/catalog.json') {
    const catalog = joinedCatalogue();
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeadersFor(origin),
    });
    res.end(JSON.stringify(catalog));
    return;
  }

  // Public submit
  if (req.method === 'POST' && url === '/submit') {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, e.status || 400, { error: e.message || 'bad request' }, origin); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch { send(res, 400, { error: 'invalid JSON' }, origin); return; }
    const entry = normaliseSubmission(parsed);
    if (!entry) { send(res, 400, { error: 'invalid submission' }, origin); return; }
    entry.ua = (req.headers['user-agent'] || '').slice(0, 200);
    try { await appendJsonl(SUBMIT_LOG, entry); }
    catch (e) { console.error('append failed', e); send(res, 500, { error: 'log write failed' }, origin); return; }
    send(res, 202, { ok: true }, origin);
    return;
  }

  // Admin GUI + API. Same-origin: do not echo the CORS allow-origin header here.
  if (url === ADMIN_PATH || url === ADMIN_PATH + '/') {
    if (req.method !== 'GET') { send(res, 405, 'method not allowed'); return; }
    serveAdminFile(req, res, 'index.html');
    return;
  }
  if (url.startsWith(ADMIN_PATH + '/api/')) {
    // Strip query string so route matching is always against the bare path.
    const rawApiPath = url.slice((ADMIN_PATH + '/api/').length);
    const [apiPath, queryStr] = rawApiPath.split('?', 2);
    const qParams = new URLSearchParams(queryStr || '');

    if (req.method === 'GET' && apiPath === 'log') {
      const limit = Math.min(Math.max(1, Number(qParams.get('limit') || 200)), 1000);
      const entries = readJsonl(SUBMIT_LOG);
      entries.reverse();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ entries: entries.slice(0, limit), total: entries.length }));
      return;
    }

    if (req.method === 'GET' && apiPath === 'queue') {
      try {
        const data = buildQueue();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      } catch (e) {
        console.error('queue build failed', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'queue build failed' }));
      }
      return;
    }

    // --- LEGACY adapter: POST /api/curated -------------------------------
    // Existing admin GUI POSTs flat { upc, name, abv, volumeMl?, flavour? }.
    // We translate that into the new model: upsert a product (matched by
    // exact name) and upsert a UPC row pointing to it. Carries flavour
    // straight through to the upc row when present.
    if (req.method === 'POST' && apiPath === 'curated') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }

      const upc      = normaliseUpc(parsed.upc);
      const name     = normaliseName(parsed.name);
      const abv      = normaliseAbv(parsed.abv);
      const volumeMl = normaliseVolume(parsed.volumeMl);
      const flavour  = normaliseFlavour(parsed.flavour);
      if (!isValidUpc(upc) || !name || abv == null) {
        res.writeHead(400); res.end('invalid curated record'); return;
      }

      const products = readProducts();
      const upcs     = readUpcs();
      const now      = new Date().toISOString();

      let prod = products.find(p => p.name === name);
      if (!prod) {
        prod = { id: makeProductId(name), name, abv, volumeMl, createdAt: now, updatedAt: now };
        products.push(prod);
      } else {
        prod.abv = abv;
        if (volumeMl != null) prod.volumeMl = volumeMl;
        prod.updatedAt = now;
      }

      const i = upcs.findIndex(u => u.upc === upc);
      const row = {
        upc,
        productId: prod.id,
        flavour,
        addedAt:   i >= 0 ? upcs[i].addedAt : now,
        updatedAt: now,
      };
      if (i >= 0) upcs[i] = row; else upcs.push(row);

      try {
        await writeJsonAtomic(PRODUCTS, products);
        await writeJsonAtomic(UPCS,     upcs);
      } catch (e) {
        console.error('curated (legacy) write failed', e);
        res.writeHead(500); res.end('write failed'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, productId: prod.id }));
      return;
    }

    // LEGACY: DELETE /api/curated/:upc — detaches the UPC from its product.
    // The product itself is left in place even if this was its last UPC;
    // admin can clean up orphan products explicitly via DELETE /api/product.
    if (req.method === 'DELETE' && apiPath.startsWith('curated/')) {
      const upc = normaliseUpc(decodeURIComponent(apiPath.slice('curated/'.length)));
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const upcs = readUpcs();
      const next = upcs.filter(u => u.upc !== upc);
      if (next.length === upcs.length) { res.writeHead(404); res.end('not found'); return; }
      try { await writeJsonAtomic(UPCS, next); }
      catch (e) { console.error('upc delete failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- New API: products list -------------------------------------------
    if (req.method === 'GET' && apiPath === 'products') {
      const products = readProducts();
      const upcs     = readUpcs();
      const upcsByProduct = new Map();
      for (const u of upcs) {
        if (!upcsByProduct.has(u.productId)) upcsByProduct.set(u.productId, []);
        upcsByProduct.get(u.productId).push({
          upc: u.upc, flavour: u.flavour || null,
          addedAt: u.addedAt || null, updatedAt: u.updatedAt || null,
        });
      }
      const out = products.map(p => ({
        ...p,
        upcs: (upcsByProduct.get(p.id) || []).sort((a, b) => a.upc.localeCompare(b.upc)),
      })).sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ products: out }));
      return;
    }

    // --- New API: upsert product ------------------------------------------
    // Body: { id?, name, abv, volumeMl? }
    if (req.method === 'POST' && apiPath === 'product') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }

      const name     = normaliseName(parsed.name);
      const abv      = normaliseAbv(parsed.abv);
      const volumeMl = normaliseVolume(parsed.volumeMl);
      if (!name || abv == null) { res.writeHead(400); res.end('invalid product'); return; }

      const products = readProducts();
      const now = new Date().toISOString();
      let prod;
      if (typeof parsed.id === 'string' && parsed.id) {
        prod = products.find(p => p.id === parsed.id);
        if (!prod) { res.writeHead(404); res.end('product not found'); return; }
        // Reject a rename that collides with another product's name.
        if (products.some(p => p.id !== prod.id && p.name === name)) {
          res.writeHead(409); res.end('another product already uses that name'); return;
        }
        prod.name = name;
        prod.abv  = abv;
        prod.volumeMl = volumeMl;
        prod.updatedAt = now;
      } else {
        if (products.some(p => p.name === name)) {
          res.writeHead(409); res.end('product with that name already exists'); return;
        }
        prod = { id: makeProductId(name), name, abv, volumeMl, createdAt: now, updatedAt: now };
        products.push(prod);
      }
      try { await writeJsonAtomic(PRODUCTS, products); }
      catch (e) { console.error('product write failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, product: prod }));
      return;
    }

    // --- New API: delete product (cascades to its UPCs) -------------------
    if (req.method === 'DELETE' && apiPath.startsWith('product/')) {
      const id = decodeURIComponent(apiPath.slice('product/'.length));
      if (!id) { res.writeHead(400); res.end('invalid id'); return; }
      const products = readProducts();
      const next = products.filter(p => p.id !== id);
      if (next.length === products.length) { res.writeHead(404); res.end('not found'); return; }
      const upcs     = readUpcs();
      const nextUpcs = upcs.filter(u => u.productId !== id);
      try {
        await writeJsonAtomic(PRODUCTS, next);
        await writeJsonAtomic(UPCS,     nextUpcs);
      } catch (e) { console.error('product delete failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removedUpcs: upcs.length - nextUpcs.length }));
      return;
    }

    // --- New API: upsert upc → product link -------------------------------
    // Body: { upc, productId, flavour? }
    if (req.method === 'POST' && apiPath === 'upc') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }

      const upc      = normaliseUpc(parsed.upc);
      const productId = typeof parsed.productId === 'string' ? parsed.productId : '';
      const flavour  = normaliseFlavour(parsed.flavour);
      if (!isValidUpc(upc) || !productId) { res.writeHead(400); res.end('invalid upc record'); return; }

      const products = readProducts();
      if (!products.some(p => p.id === productId)) { res.writeHead(404); res.end('product not found'); return; }

      const upcs = readUpcs();
      const now = new Date().toISOString();
      const i = upcs.findIndex(u => u.upc === upc);
      const row = {
        upc, productId, flavour,
        addedAt:   i >= 0 ? upcs[i].addedAt : now,
        updatedAt: now,
      };
      if (i >= 0) upcs[i] = row; else upcs.push(row);

      try { await writeJsonAtomic(UPCS, upcs); }
      catch (e) { console.error('upc write failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry: row }));
      return;
    }

    // --- New API: detach a UPC --------------------------------------------
    if (req.method === 'DELETE' && apiPath.startsWith('upc/')) {
      const upc = normaliseUpc(decodeURIComponent(apiPath.slice('upc/'.length)));
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const upcs = readUpcs();
      const next = upcs.filter(u => u.upc !== upc);
      if (next.length === upcs.length) { res.writeHead(404); res.end('not found'); return; }
      try { await writeJsonAtomic(UPCS, next); }
      catch (e) { console.error('upc delete failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && apiPath === 'reject') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }
      const upc = normaliseUpc(parsed.upc);
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '';
      try { await appendJsonl(REJECTED, { upc, reason, at: new Date().toISOString() }); }
      catch (e) { console.error('reject log failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && apiPath === 'deploy') {
      // Snapshot all three data files before pulling. curated.json and
      // rejected.jsonl are tracked in git (seed data), so `git pull` would
      // overwrite them. submissions.jsonl is gitignored but we snapshot it
      // too for safety. After the pull we restore every file unconditionally.
      // CURATED_LEGACY (curated.json) is included so a deploy that includes
      // the products+upcs migration commit doesn't wipe prod's pre-migration
      // data: the pull deletes it from the working tree (the commit removes
      // it from git), then we restore it from the snapshot so the migration
      // run on the next boot can convert it.
      const dataFiles = [SUBMIT_LOG, PRODUCTS, UPCS, REJECTED, CURATED_LEGACY];
      const snapshots = dataFiles.map(f => {
        try { return { f, buf: fs.existsSync(f) ? fs.readFileSync(f) : null }; }
        catch { return { f, buf: null }; }
      });

      // -c safe.directory=<path> works around git's "dubious ownership" check
      // when the repo on disk is owned by a different user than the one running
      // node. Avoids needing a manual `git config --global` step on the host.
      execFile('git', ['-c', `safe.directory=${REPO_ROOT}`, '-C', REPO_ROOT, 'pull', '--ff-only'], { timeout: 30000 }, (err, stdout, stderr) => {
        // Always restore data files — even if the pull failed we don't want
        // a partial pull to leave the repo files in place.
        for (const { f, buf } of snapshots) {
          if (buf !== null) try { fs.writeFileSync(f, buf); } catch {}
        }

        const restarting = !err && RESTART_ON_DEPLOY;
        const body = { ok: !err, stdout: stdout || '', stderr: stderr || '', restarting };
        if (err) body.error = err.message;

        // Flush the response BEFORE killing ourselves. systemd (Restart=always)
        // brings us back instantly; the detached shell is what actually issues
        // the restart so it survives our SIGTERM.
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body), () => {
          if (!restarting) return;
          try {
            const child = spawn('sh', ['-c', `sleep 1 && systemctl restart ${SYSTEMD_UNIT}`], {
              detached: true, stdio: 'ignore',
            });
            child.unref();
          } catch (e) { console.error('restart spawn failed', e); }
        });
      });
      return;
    }

    res.writeHead(404); res.end('admin route not found');
    return;
  }

  send(res, 404, { error: 'not found' }, origin);
});

try { migrateIfNeeded(); }
catch (e) { console.error('Migration failed:', e); process.exit(1); }

server.listen(PORT, () => {
  console.log(`Beer Converter API listening on :${PORT}`);
  console.log(`  submit log : ${SUBMIT_LOG}`);
  console.log(`  products   : ${PRODUCTS}`);
  console.log(`  upcs       : ${UPCS}`);
  console.log(`  rejected   : ${REJECTED}`);
  console.log(`  admin path : ${ADMIN_PATH}/`);
});
