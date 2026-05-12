// Beer Converter backend.
//
// Three surfaces in one Node process backed by a single SQLite file (data.db):
//
//   1. Public submit endpoint
//        POST /submit           — accept { upc, name, abv, volumeMl? }
//
//   2. Public catalogue
//        GET  /catalog.json     — JOINed product + upc dataset, fetched at
//                                 app load time
//
//   3. Public shared sessions (auth = obfuscation; the link IS the credential)
//        POST   /api/sessions
//        GET    /api/sessions/:sid
//        PATCH  /api/sessions/:sid                 — name, benchmarkPresetKey
//        DELETE /api/sessions/:sid
//        POST   /api/sessions/:sid/people
//        PATCH  /api/sessions/:sid/people/:pid
//        DELETE /api/sessions/:sid/people/:pid
//        POST   /api/sessions/:sid/presets         — upsert by presetKey
//        PATCH  /api/sessions/:sid/presets/:key    — cascade to all linked drinks
//        POST   /api/sessions/:sid/presets/:key/touch
//        DELETE /api/sessions/:sid/presets/:key
//        POST   /api/sessions/:sid/drinks
//        PATCH  /api/sessions/:sid/drinks/:did
//        DELETE /api/sessions/:sid/drinks/:did
//
//   4. Curation admin (unique path; user runs it behind their own protection)
//        GET  ${ADMIN_PATH}/                  — single-page admin GUI
//        GET  ${ADMIN_PATH}/api/queue         — pending submissions + suggestions
//        GET  ${ADMIN_PATH}/api/sessions      — list of shared sessions (overview)
//        GET  ${ADMIN_PATH}/api/products      — list products + their upcs
//        POST ${ADMIN_PATH}/api/product       — upsert one product
//        DEL  ${ADMIN_PATH}/api/product/:id   — delete product + cascade upcs
//        POST ${ADMIN_PATH}/api/upc           — upsert one upc → product link
//        DEL  ${ADMIN_PATH}/api/upc/:upc      — detach a UPC
//        POST ${ADMIN_PATH}/api/curated       — LEGACY adapter (writes new model)
//        DEL  ${ADMIN_PATH}/api/curated/:upc  — LEGACY adapter
//        POST ${ADMIN_PATH}/api/reject        — mark a UPC as rejected
//        GET  ${ADMIN_PATH}/api/backups      — list database backup versions
//        POST ${ADMIN_PATH}/api/backups      — create a database backup version
//        GET  ${ADMIN_PATH}/api/backups/:f   — download a database backup
//        POST ${ADMIN_PATH}/api/deploy        — git pull, data files preserved
//
// Run:
//   node server/index.js                         # listens on $PORT or 8787
//   ADMIN_PATH=/_my_admin_xyz node server/index.js
//
// Storage:
//   data.db                — SQLite file. See server/db.js for schema.
//   *.json{,l}.migrated    — old JSON/JSONL files kept after one-shot
//                            import on first boot of the SQLite version.
//   curated.legacy.json    — pre-products+upcs archive, kept for rollback only.

const http       = require('node:http');
const fs         = require('node:fs');
const path       = require('node:path');
const { execFile, spawn } = require('node:child_process');

const db = require('./db.js');

const REPO_ROOT         = path.join(__dirname, '..');
// systemd unit to restart after a successful deploy. Set RESTART_ON_DEPLOY=0
// to disable (e.g. when running outside systemd).
const SYSTEMD_UNIT      = process.env.SYSTEMD_UNIT || 'bc-node.service';
const RESTART_ON_DEPLOY = process.env.RESTART_ON_DEPLOY !== '0';

const PORT       = Number(process.env.PORT) || 8787;
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const ADMIN_DIR  = path.join(__dirname, 'admin');
const ADMIN_PATH = (process.env.ADMIN_PATH || '/_admin_8f3k9qz4').replace(/\/+$/, '');
const MAX_BODY   = 16 * 1024;

// CORS allowlist for /submit + /catalog.json (the admin path is same-origin only).
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGIN ||
  'https://bc.ajwest.ca,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8787,http://127.0.0.1:8787'
).split(',').map(s => s.trim()).filter(Boolean);

function corsHeadersFor(reqOrigin) {
  const allow =
    ALLOW_ORIGINS.includes('*') ? '*' :
    (reqOrigin && ALLOW_ORIGINS.includes(reqOrigin)) ? reqOrigin :
    null;
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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

// --- normalisation ---------------------------------------------------------

function normaliseUpc(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, '') : '';
}
function isValidUpc(s) { return /^\d{6,20}$/.test(s); }

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

// Product `id` is a slug + 4-char random hex so renames are cheap (no UPC
// rows touched). UPCs reference products by id, never by name.
function makeProductId(name) {
  const slug = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'p';
  const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `p_${slug}_${hex}`;
}

// --- legacy curated.json → products+upcs migration -------------------------
//
// This pre-dates the SQLite migration. It runs first so a deploy carrying
// only a legacy curated.json gets rewritten into products.json + upcs.json,
// which the SQLite migration then picks up. Idempotent: skipped if either
// new-shape file already exists.

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

function migrateLegacyCuratedIfNeeded() {
  const PRODUCTS_JSON = path.join(DATA_DIR, 'products.json');
  const UPCS_JSON     = path.join(DATA_DIR, 'upcs.json');
  const CURATED_JSON  = path.join(DATA_DIR, 'curated.json');
  const CURATED_ARCHIVED = path.join(DATA_DIR, 'curated.legacy.json');

  if (fs.existsSync(PRODUCTS_JSON) || fs.existsSync(UPCS_JSON)) return;

  const legacy = readJsonSafe(CURATED_JSON, null);
  if (!Array.isArray(legacy)) return;

  console.log(`legacy migration: converting ${legacy.length} curated entries…`);
  const productsByName = new Map();
  const upcs = [];

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
        name, abv, volumeMl: vol,
        createdAt: c.updatedAt || new Date().toISOString(),
        updatedAt: c.updatedAt || new Date().toISOString(),
      };
      productsByName.set(name, prod);
    } else if (prod.volumeMl == null && vol != null) {
      prod.volumeMl = vol;
    }
    upcs.push({
      upc, productId: prod.id, flavour: null,
      addedAt: c.updatedAt || new Date().toISOString(),
    });
  }
  fs.writeFileSync(PRODUCTS_JSON, JSON.stringify([...productsByName.values()], null, 2));
  fs.writeFileSync(UPCS_JSON,     JSON.stringify(upcs, null, 2));
  try { fs.renameSync(CURATED_JSON, CURATED_ARCHIVED); } catch {}
  console.log(`legacy migration: ${productsByName.size} products, ${upcs.length} upcs.`);
}

// --- submission normalisation ----------------------------------------------

function normaliseSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) return null;
  const abv = Number(raw.abv);
  if (!Number.isFinite(abv) || abv < 0 || abv > 100) return null;
  const out = { name, abv: +abv.toFixed(2), receivedAt: new Date().toISOString() };
  const upc = normaliseUpc(raw.upc || '');
  if (upc && isValidUpc(upc)) out.upc = upc;
  if (raw.volumeMl != null) {
    const v = Number(raw.volumeMl);
    if (Number.isFinite(v) && v > 0 && v < 100000) out.volumeMl = +v.toFixed(2);
  }
  if (typeof raw.flavour === 'string' && raw.flavour.trim()) {
    out.flavour = raw.flavour.trim().slice(0, 60);
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
  const submissions = db.listSubmissions();
  const curated     = db.joinedCatalogue();
  const rejected    = db.listRejected();

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
// "White Claw Mango" ↔ "White Claw Black Cherry" kind of matches.
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

// --- sessions handler ------------------------------------------------------

const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function handleSessionRoute(req, res, url, origin) {
  // Strip query string; route on bare path.
  const [pathOnly] = url.split('?', 1);
  const parts = pathOnly.split('/').filter(Boolean);   // ['api','sessions',...]
  // parts[0] = 'api', parts[1] = 'sessions'

  if (parts[2] === 'reports') {
    return handleReportRoute(req, res, url, origin, 3);
  }

  const sid       = parts[2];
  const subType   = parts[3];   // 'people' | 'presets' | 'drinks' | undefined
  const subId     = parts[4];   // person id, preset key, or drink id

  // POST /api/sessions  — create
  if (req.method === 'POST' && parts.length === 2) {
    const body = await safeJsonBody(req, res, origin); if (body == null) return;
    let session;
    try { session = db.createSession(body || {}); }
    catch (e) { console.error('createSession failed', e); send(res, 500, { error: 'create failed' }, origin); return; }
    send(res, 201, session, origin);
    return;
  }

  // Past this point we always need a sid.
  if (!sid || !SID_RE.test(sid)) { send(res, 404, { error: 'session not found' }, origin); return; }

  // GET /api/sessions/:sid  — full session
  if (req.method === 'GET' && parts.length === 3) {
    const session = db.getSessionFull(sid);
    if (!session) { send(res, 404, { error: 'session not found' }, origin); return; }
    send(res, 200, session, origin);
    return;
  }

  // PATCH /api/sessions/:sid  — rename / set benchmark
  if (req.method === 'PATCH' && parts.length === 3) {
    if (!db.getSessionMeta(sid)) { send(res, 404, { error: 'session not found' }, origin); return; }
    const body = await safeJsonBody(req, res, origin); if (body == null) return;
    if (typeof body.name === 'string') db.renameSession(sid, body.name);
    if ('benchmarkPresetKey' in body) db.setBenchmark(sid, body.benchmarkPresetKey);
    send(res, 200, db.getSessionFull(sid), origin);
    return;
  }

  // DELETE /api/sessions/:sid
  if (req.method === 'DELETE' && parts.length === 3) {
    const ok = db.deleteSession(sid);
    if (!ok) { send(res, 404, { error: 'session not found' }, origin); return; }
    send(res, 200, { ok: true }, origin);
    return;
  }

  if (!db.getSessionMeta(sid)) { send(res, 404, { error: 'session not found' }, origin); return; }

  // ---- /people ----
  if (subType === 'people') {
    if (req.method === 'POST' && parts.length === 4) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const person = db.addPerson(sid, body.name);
      send(res, 201, person, origin);
      return;
    }
    const personId = Number(subId);
    if (!Number.isInteger(personId) || personId <= 0) {
      send(res, 400, { error: 'invalid person id' }, origin); return;
    }
    if (req.method === 'PATCH' && parts.length === 5) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const ok = db.renamePerson(sid, personId, body.name);
      if (!ok) { send(res, 400, { error: 'rename failed' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'DELETE' && parts.length === 5) {
      const ok = db.removePerson(sid, personId);
      if (!ok) { send(res, 400, { error: 'remove failed (last person?)' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
  }

  // ---- /presets ----
  if (subType === 'presets') {
    if (req.method === 'POST' && parts.length === 4) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const isCocktail = body?.inputKind === 'cocktail' && Array.isArray(body.components) && body.components.length > 0;
      if (!body || !body.presetKey || !body.name || (!isCocktail && (body.volumeMl == null || body.abv == null))) {
        send(res, 400, { error: 'missing fields' }, origin); return;
      }
      try {
        const preset = db.upsertPreset(sid, body);
        send(res, 200, preset, origin);
      } catch (e) {
        const status = e.status || 500;
        send(res, status, { error: e.message || 'save preset failed' }, origin);
      }
      return;
    }
    const key = subId;
    if (!key) { send(res, 400, { error: 'invalid preset key' }, origin); return; }
    if (req.method === 'PATCH' && parts.length === 5) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      // Cascade-update: bumps both the preset row and every drink linked to it.
      const next = db.updatePresetCascade(sid, key, body);
      if (!next) { send(res, 404, { error: 'preset not found' }, origin); return; }
      send(res, 200, next, origin);
      return;
    }
    if (req.method === 'POST' && parts.length === 6 && parts[5] === 'touch') {
      db.touchPreset(sid, key);
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'DELETE' && parts.length === 5) {
      const ok = db.removePreset(sid, key);
      if (!ok) { send(res, 404, { error: 'preset not found' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
  }

  // ---- /drinks ----
  if (subType === 'drinks') {
    if (req.method === 'POST' && parts.length === 4) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const hasCocktailComponents = body?.inputKind === 'cocktail' && Array.isArray(body.components) && body.components.length > 0;
      if (!body || !Number.isInteger(Number(body.personId))
          || (!hasCocktailComponents && (body.volumeMl == null || body.abv == null))) {
        send(res, 400, { error: 'missing fields' }, origin); return;
      }
      try {
        const drink = db.addDrink(sid, {
          personId: Number(body.personId),
          presetKey: body.presetKey || null,
          name: body.name,
          flavour: body.flavour,
          volumeMl: body.volumeMl == null ? null : Number(body.volumeMl),
          abv: body.abv == null ? null : Number(body.abv),
          inputKind: body.inputKind,
          components: body.components,
          t: body.t,
        });
        send(res, 201, drink, origin);
      } catch (e) {
        const status = e.status || 500;
        send(res, status, { error: e.message || 'add drink failed' }, origin);
      }
      return;
    }
    const drinkId = Number(subId);
    if (!Number.isInteger(drinkId) || drinkId <= 0) {
      send(res, 400, { error: 'invalid drink id' }, origin); return;
    }
    if (req.method === 'PATCH' && parts.length === 5) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const next = db.updateDrink(sid, drinkId, body);
      if (!next) { send(res, 404, { error: 'drink not found' }, origin); return; }
      send(res, 200, next, origin);
      return;
    }
    if (req.method === 'DELETE' && parts.length === 5) {
      const ok = db.removeDrink(sid, drinkId);
      if (!ok) { send(res, 404, { error: 'drink not found' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
  }

  // ---- /comments ----
  if (subType === 'comments') {
    if (req.method === 'POST' && parts.length === 4) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      if (!body || !body.text) {
        send(res, 400, { error: 'missing text' }, origin); return;
      }
      try {
        const comment = db.addComment(sid, {
          personId:   body.personId != null ? Number(body.personId) : null,
          authorName: body.authorName || null,
          text:       body.text,
          t:          body.t,
        });
        send(res, 201, comment, origin);
      } catch (e) {
        const status = e.status || 500;
        send(res, status, { error: e.message || 'add comment failed' }, origin);
      }
      return;
    }
    const commentId = Number(subId);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      send(res, 400, { error: 'invalid comment id' }, origin); return;
    }
    if (req.method === 'PATCH' && parts.length === 5) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      const next = db.updateComment(sid, commentId, body);
      if (!next) { send(res, 404, { error: 'comment not found' }, origin); return; }
      send(res, 200, next, origin);
      return;
    }
    if (req.method === 'DELETE' && parts.length === 5) {
      const ok = db.removeComment(sid, commentId);
      if (!ok) { send(res, 404, { error: 'comment not found' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
    // POST /api/sessions/:sid/comments/:cid/react
    if (req.method === 'POST' && parts.length === 6 && parts[5] === 'react') {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      if (!body || !body.emoji) {
        send(res, 400, { error: 'missing emoji' }, origin); return;
      }
      const ok = db.toggleReaction(sid, commentId, {
        personId: body.personId != null ? Number(body.personId) : null,
        deviceId: body.deviceId ? String(body.deviceId).slice(0, 64) : null,
        authorName: body.authorName ? String(body.authorName).trim().slice(0, 40) : null,
        emoji: String(body.emoji).slice(0, 10),
      });
      if (!ok) { send(res, 404, { error: 'comment not found' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
  }

  send(res, 404, { error: 'session route not found' }, origin);
}

async function handleReportRoute(req, res, url, origin, idIndex = 2) {
  const [pathOnly] = url.split('?', 1);
  const parts = pathOnly.split('/').filter(Boolean);
  const rid = parts[idIndex];
  const subType = parts[idIndex + 1];
  const subId = parts[idIndex + 2];

  if (!rid || !SID_RE.test(rid)) { send(res, 404, { error: 'report not found' }, origin); return; }

  if (req.method === 'GET' && parts.length === idIndex + 1) {
    const report = db.getReportFull(rid);
    if (!report) { send(res, 404, { error: 'report not found' }, origin); return; }
    send(res, 200, report, origin);
    return;
  }

  const sid = db.getPrivateSessionIdForReport(rid);
  if (!sid) { send(res, 404, { error: 'report not found' }, origin); return; }

  if (subType === 'comments') {
    if (req.method === 'POST' && parts.length === idIndex + 2) {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      if (!body || !body.text) {
        send(res, 400, { error: 'missing text' }, origin); return;
      }
      try {
        const comment = db.addComment(sid, {
          personId:   body.personId != null ? Number(body.personId) : null,
          authorName: body.authorName || null,
          text:       body.text,
          t:          body.t,
        });
        send(res, 201, comment, origin);
      } catch (e) {
        const status = e.status || 500;
        send(res, status, { error: e.message || 'add comment failed' }, origin);
      }
      return;
    }

    const commentId = Number(subId);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      send(res, 400, { error: 'invalid comment id' }, origin); return;
    }
    if (req.method === 'POST' && parts.length === idIndex + 4 && parts[idIndex + 3] === 'react') {
      const body = await safeJsonBody(req, res, origin); if (body == null) return;
      if (!body || !body.emoji) {
        send(res, 400, { error: 'missing emoji' }, origin); return;
      }
      const ok = db.toggleReaction(sid, commentId, {
        personId: body.personId != null ? Number(body.personId) : null,
        deviceId: body.deviceId ? String(body.deviceId).slice(0, 64) : null,
        authorName: body.authorName ? String(body.authorName).trim().slice(0, 40) : null,
        emoji: String(body.emoji).slice(0, 10),
      });
      if (!ok) { send(res, 404, { error: 'comment not found' }, origin); return; }
      send(res, 200, { ok: true }, origin);
      return;
    }
  }

  send(res, 404, { error: 'report route not found' }, origin);
}

// readBody + JSON.parse with consistent error responses. Returns null after
// emitting the error response, so callers can early-return.
async function safeJsonBody(req, res, origin) {
  let body;
  try { body = await readBody(req); }
  catch (e) { send(res, e.status || 400, { error: e.message || 'bad request' }, origin); return null; }
  if (!body) return {};
  try { return JSON.parse(body); }
  catch { send(res, 400, { error: 'invalid JSON' }, origin); return null; }
}

function serveStatic(req, res, relPath, origin) {
  const safe = relPath.replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '');
  const file = safe ? path.join(REPO_ROOT, safe) : path.join(REPO_ROOT, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (err.code === 'ENOENT' && !safe.includes('.')) {
        return serveStatic(req, res, '', origin);
      }
      send(res, 404, 'Asset not found', origin);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const ct = ext === '.html' ? 'text/html; charset=utf-8'
             : ext === '.css'  ? 'text/css; charset=utf-8'
             : ext === '.js'   ? 'application/javascript; charset=utf-8'
             : ext === '.png'  ? 'image/png'
             : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
             : ext === '.svg'  ? 'image/svg+xml'
             : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      ...corsHeadersFor(origin),
    });
    res.end(buf);
  });
}

// --- request router --------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url    = req.url || '/';
  const [pathPart] = url.split('?', 1);
  const pathOnly = pathPart || '/';

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(origin));
    res.end();
    return;
  }

  if (req.method === 'GET' && pathOnly === '/health') {
    send(res, 200, { ok: true, adminPath: ADMIN_PATH }, origin);
    return;
  }

  if (req.method === 'GET' && pathOnly === '/catalog.json') {
    const catalog = db.joinedCatalogue();
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeadersFor(origin),
    });
    res.end(JSON.stringify(catalog));
    return;
  }

  if (req.method === 'GET' && (pathOnly === '/report' || pathOnly === '/report/')) {
    return serveStatic(req, res, 'report.html', origin);
  }

  // ---- Public sessions API -----------------------------------------------
  // No auth: knowing the session id IS the credential. Anyone with the link
  // can read or write. The admin overview (GET /api/sessions) lives under
  // the admin path and is NOT exposed publicly.
  if (pathOnly === '/api/sessions' || pathOnly.startsWith('/api/sessions/')) {
    return handleSessionRoute(req, res, url, origin);
  }

  if (pathOnly.startsWith('/api/reports/')) {
    return handleReportRoute(req, res, url, origin);
  }

  if (req.method === 'POST' && pathOnly === '/submit') {
    let body;
    try { body = await readBody(req); }
    catch (e) { send(res, e.status || 400, { error: e.message || 'bad request' }, origin); return; }
    let parsed;
    try { parsed = JSON.parse(body); } catch { send(res, 400, { error: 'invalid JSON' }, origin); return; }
    const entry = normaliseSubmission(parsed);
    if (!entry) { send(res, 400, { error: 'invalid submission' }, origin); return; }
    entry.ua = (req.headers['user-agent'] || '').slice(0, 200);
    try { db.appendSubmission(entry); }
    catch (e) { console.error('submission insert failed', e); send(res, 500, { error: 'insert failed' }, origin); return; }
    send(res, 202, { ok: true }, origin);
    return;
  }

  // Admin GUI + API. Same-origin: do not echo the CORS allow-origin header here.
  if (pathOnly === ADMIN_PATH || pathOnly === ADMIN_PATH + '/') {
    if (req.method !== 'GET') { send(res, 405, 'method not allowed'); return; }
    serveAdminFile(req, res, 'index.html');
    return;
  }
  if (pathOnly.startsWith(ADMIN_PATH + '/api/')) {
    const rawApiPath = pathOnly.slice((ADMIN_PATH + '/api/').length);
    const [apiPath] = rawApiPath.split('?', 1);
    const queryStr = url.split('?', 2)[1] || '';
    const qParams = new URLSearchParams(queryStr);

    // Admin overview of all sessions. Same data shape as the SQL view —
    // session id, name, counts, last activity. The admin GUI uses this to
    // pick a session to "log into" (just opens /?s=<sid> in a new tab).
    if (req.method === 'GET' && apiPath === 'sessions') {
      const sessions = db.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ sessions }));
      return;
    }

    if (req.method === 'GET' && apiPath === 'log') {
      const limit = Math.min(Math.max(1, Number(qParams.get('limit') || 200)), 1000);
      const entries = db.listSubmissions({ limit });
      const total   = db.countSubmissions();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ entries, total }));
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

    if (req.method === 'GET' && apiPath === 'backups') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ backups: db.listBackups() }));
      } catch (e) {
        console.error('backup list failed', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'backup list failed' }));
      }
      return;
    }

    if (req.method === 'POST' && apiPath === 'backups') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed = {};
      if (body) {
        try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }
      }
      try {
        const backup = await db.createBackup({ label: parsed.label });
        res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, backup, backups: db.listBackups() }));
      } catch (e) {
        console.error('backup create failed', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'backup create failed' }));
      }
      return;
    }

    if (req.method === 'GET' && apiPath.startsWith('backups/')) {
      const filename = decodeURIComponent(apiPath.slice('backups/'.length));
      const file = db.backupPath(filename);
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('backup not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.sqlite3',
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // --- LEGACY adapter: POST /api/curated -------------------------------
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
      let prod;
      try {
        prod = db.upsertCurated({
          upc, name, abv, volumeMl, flavour,
          makeProductId: () => makeProductId(name),
        });
      } catch (e) {
        console.error('curated upsert failed', e);
        res.writeHead(500); res.end('write failed'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, productId: prod.id }));
      return;
    }

    if (req.method === 'DELETE' && apiPath.startsWith('curated/')) {
      const upc = normaliseUpc(decodeURIComponent(apiPath.slice('curated/'.length)));
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const ok = db.deleteUpc(upc);
      if (!ok) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // --- products list ----------------------------------------------------
    if (req.method === 'GET' && apiPath === 'products') {
      const products = db.listProducts();
      const upcs     = db.listUpcs();
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

    // --- upsert product ---------------------------------------------------
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

      const now = new Date().toISOString();
      let prod;
      try {
        if (typeof parsed.id === 'string' && parsed.id) {
          prod = db.getProductById(parsed.id);
          if (!prod) { res.writeHead(404); res.end('product not found'); return; }
          const collision = db.getProductByName(name);
          if (collision && collision.id !== prod.id) {
            res.writeHead(409); res.end('another product already uses that name'); return;
          }
          prod.name = name;
          prod.abv  = abv;
          prod.volumeMl = volumeMl;
          prod.updatedAt = now;
          db.updateProduct(prod);
        } else {
          if (db.getProductByName(name)) {
            res.writeHead(409); res.end('product with that name already exists'); return;
          }
          prod = { id: makeProductId(name), name, abv, volumeMl, createdAt: now, updatedAt: now };
          db.insertProduct(prod);
        }
      } catch (e) {
        console.error('product upsert failed', e);
        res.writeHead(500); res.end('write failed'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, product: prod }));
      return;
    }

    // --- delete product (cascades to its UPCs via FK) ---------------------
    if (req.method === 'DELETE' && apiPath.startsWith('product/')) {
      const id = decodeURIComponent(apiPath.slice('product/'.length));
      if (!id) { res.writeHead(400); res.end('invalid id'); return; }
      let result;
      try { result = db.deleteProduct(id); }
      catch (e) { console.error('product delete failed', e); res.writeHead(500); res.end('write failed'); return; }
      if (!result.deleted) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removedUpcs: result.removedUpcs }));
      return;
    }

    // --- upsert upc → product link ----------------------------------------
    if (req.method === 'POST' && apiPath === 'upc') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }

      const upc       = normaliseUpc(parsed.upc);
      const productId = typeof parsed.productId === 'string' ? parsed.productId : '';
      const flavour   = normaliseFlavour(parsed.flavour);
      if (!isValidUpc(upc) || !productId) { res.writeHead(400); res.end('invalid upc record'); return; }
      if (!db.getProductById(productId))  { res.writeHead(404); res.end('product not found'); return; }

      const now = new Date().toISOString();
      const existing = db.getUpc(upc);
      const row = {
        upc, productId, flavour,
        addedAt:   existing ? existing.addedAt : now,
        updatedAt: now,
      };
      try { db.upsertUpc(row); }
      catch (e) { console.error('upc upsert failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry: row }));
      return;
    }

    if (req.method === 'DELETE' && apiPath.startsWith('upc/')) {
      const upc = normaliseUpc(decodeURIComponent(apiPath.slice('upc/'.length)));
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const ok = db.deleteUpc(upc);
      if (!ok) { res.writeHead(404); res.end('not found'); return; }
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
      try { db.appendRejected(upc, reason); }
      catch (e) { console.error('reject insert failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && apiPath === 'deploy') {
      // data.db isn't tracked in git, so a normal pull won't touch it. We
      // still snapshot it for safety in case someone accidentally commits
      // the file. Same defensive logic for any *.migrated leftovers.
      const dataFiles = [
        path.join(DATA_DIR, 'data.db'),
        path.join(DATA_DIR, 'data.db-wal'),
        path.join(DATA_DIR, 'data.db-shm'),
      ];
      const snapshots = dataFiles.map(f => {
        try { return { f, buf: fs.existsSync(f) ? fs.readFileSync(f) : null }; }
        catch { return { f, buf: null }; }
      });

      execFile('git', ['-c', `safe.directory=${REPO_ROOT}`, '-C', REPO_ROOT, 'pull', '--ff-only'], { timeout: 30000 }, (err, stdout, stderr) => {
        for (const { f, buf } of snapshots) {
          if (buf !== null) try { fs.writeFileSync(f, buf); } catch {}
        }

        const restarting = !err && RESTART_ON_DEPLOY;
        const body = { ok: !err, stdout: stdout || '', stderr: stderr || '', restarting };
        if (err) body.error = err.message;

        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body), () => {
          if (!restarting) return;
          try {
            // Run npm install before restart so a new dep (or version bump)
            // is available to the relaunched process. Tolerant: install
            // failure is logged but doesn't block the restart.
            const cmd = `(cd ${JSON.stringify(REPO_ROOT)} && npm install --omit=dev) ; sleep 1 && systemctl restart ${SYSTEMD_UNIT}`;
            const child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
            child.unref();
          } catch (e) { console.error('restart spawn failed', e); }
        });
      });
      return;
    }

    res.writeHead(404); res.end('admin route not found');
    return;
  }

  // Fallback to serving static files for any other GET request.
  if (req.method === 'GET') {
    const relPath = pathOnly === '/' ? 'index.html' : pathOnly;
    return serveStatic(req, res, relPath, origin);
  }

  send(res, 404, { error: 'not found' }, origin);
});

// Boot order: legacy curated → JSON migration runs first (a no-op once that
// migration has happened in production), then SQLite slurps any JSON files
// that exist into the DB.
try { migrateLegacyCuratedIfNeeded(); }
catch (e) { console.error('legacy curated migration failed:', e); process.exit(1); }
try { db.migrateFromJsonIfNeeded(); }
catch (e) { console.error('SQLite migration failed:', e); process.exit(1); }

server.listen(PORT, () => {
  console.log(`Beer Converter API listening on :${PORT}`);
  console.log(`  database   : ${db.DB_PATH}`);
  console.log(`  admin path : ${ADMIN_PATH}/`);
});
