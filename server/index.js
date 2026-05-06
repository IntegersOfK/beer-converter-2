// Beer Converter backend.
//
// Three surfaces in one zero-dependency Node process:
//
//   1. Public submit endpoint
//        POST /submit           — accept { upc, name, abv } from the app
//
//   2. Public catalogue
//        GET  /catalog.json     — curated dataset, fetched at app load time
//
//   3. Curation admin (unique path; user runs it behind their own protection)
//        GET  ${ADMIN_PATH}/             — single-page admin GUI
//        GET  ${ADMIN_PATH}/api/queue    — pending submissions + suggestions
//        POST ${ADMIN_PATH}/api/curated  — upsert one curated record
//        DEL  ${ADMIN_PATH}/api/curated  — remove a curated record by UPC
//        POST ${ADMIN_PATH}/api/reject   — mark a UPC as rejected (hide from queue)
//        POST ${ADMIN_PATH}/api/deploy   — git pull latest, data files preserved
//
// Run:
//   node server/index.js                         # listens on $PORT or 8787
//   ADMIN_PATH=/_my_admin_xyz node server/index.js
//
// Files written next to this one (override DATA_DIR to relocate):
//   submissions.jsonl  — append-only raw submissions from the app
//   curated.json       — array of canonical { upc, name, abv, volumeMl?, group? }
//   rejected.jsonl     — append-only log of UPCs marked junk

const http       = require('node:http');
const fs         = require('node:fs');
const path       = require('node:path');
const { execFile, spawn } = require('node:child_process');

const REPO_ROOT         = path.join(__dirname, '..');
// systemd unit to restart after a successful deploy. Set RESTART_ON_DEPLOY=0
// to disable (e.g. when running outside systemd).
const SYSTEMD_UNIT      = process.env.SYSTEMD_UNIT || 'bc-node.service';
const RESTART_ON_DEPLOY = process.env.RESTART_ON_DEPLOY !== '0';

const PORT       = Number(process.env.PORT) || 8787;
const DATA_DIR   = process.env.DATA_DIR || __dirname;
const SUBMIT_LOG = path.join(DATA_DIR, 'submissions.jsonl');
const CURATED    = path.join(DATA_DIR, 'curated.json');
const REJECTED   = path.join(DATA_DIR, 'rejected.jsonl');
const ADMIN_DIR  = path.join(__dirname, 'admin');
const ADMIN_PATH = (process.env.ADMIN_PATH || '/_admin_8f3k9qz4').replace(/\/+$/, '');
const MAX_BODY   = 8 * 1024;   // 8 KB — generous for a curated record

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

function normaliseSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const upc = normaliseUpc(raw.upc);
  if (!isValidUpc(upc)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) return null;
  const abv = Number(raw.abv);
  if (!Number.isFinite(abv) || abv < 0 || abv > 100) return null;
  const out = { upc, name, abv: +abv.toFixed(2), receivedAt: new Date().toISOString() };
  if (raw.volumeMl != null) {
    const v = Number(raw.volumeMl);
    if (Number.isFinite(v) && v > 0 && v < 100000) out.volumeMl = +v.toFixed(2);
  }
  return out;
}

function normaliseCurated(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const upc = normaliseUpc(raw.upc);
  if (!isValidUpc(upc)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 80) return null;
  const abv = Number(raw.abv);
  if (!Number.isFinite(abv) || abv < 0 || abv > 100) return null;
  const out = { upc, name, abv: +abv.toFixed(2) };
  if (raw.volumeMl != null) {
    const v = Number(raw.volumeMl);
    if (Number.isFinite(v) && v > 0 && v < 100000) out.volumeMl = +v.toFixed(2);
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

// --- queue construction ----------------------------------------------------
// Pending = UPCs that have submissions but are NOT in curated and NOT rejected.
// Aggregate per UPC so a popular product collapses into one card.
function buildQueue() {
  const submissions = readJsonl(SUBMIT_LOG);
  const curated     = readJsonSafe(CURATED, []);
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

  // Public catalogue
  if (req.method === 'GET' && url === '/catalog.json') {
    const curated = readJsonSafe(CURATED, []);
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeadersFor(origin),
    });
    res.end(JSON.stringify(curated));
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
    const apiPath = url.slice((ADMIN_PATH + '/api/').length);

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

    if (req.method === 'POST' && apiPath === 'curated') {
      let body;
      try { body = await readBody(req); }
      catch (e) { res.writeHead(e.status || 400); res.end(e.message || 'bad request'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid JSON'); return; }
      const entry = normaliseCurated(parsed);
      if (!entry) { res.writeHead(400); res.end('invalid curated record'); return; }
      const list = readJsonSafe(CURATED, []);
      const i = list.findIndex(c => c.upc === entry.upc);
      if (i >= 0) list[i] = entry; else list.push(entry);
      try { await writeJsonAtomic(CURATED, list); }
      catch (e) { console.error('curated write failed', e); res.writeHead(500); res.end('write failed'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry }));
      return;
    }

    if (req.method === 'DELETE' && apiPath.startsWith('curated/')) {
      const upc = normaliseUpc(decodeURIComponent(apiPath.slice('curated/'.length)));
      if (!isValidUpc(upc)) { res.writeHead(400); res.end('invalid upc'); return; }
      const list = readJsonSafe(CURATED, []);
      const next = list.filter(c => c.upc !== upc);
      if (next.length === list.length) { res.writeHead(404); res.end('not found'); return; }
      try { await writeJsonAtomic(CURATED, next); }
      catch (e) { console.error('curated write failed', e); res.writeHead(500); res.end('write failed'); return; }
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
      const dataFiles = [SUBMIT_LOG, CURATED, REJECTED];
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

server.listen(PORT, () => {
  console.log(`Beer Converter API listening on :${PORT}`);
  console.log(`  submit log : ${SUBMIT_LOG}`);
  console.log(`  curated    : ${CURATED}`);
  console.log(`  rejected   : ${REJECTED}`);
  console.log(`  admin path : ${ADMIN_PATH}/`);
});
