// Entry point. Wires DOM events to state + UI, and orchestrates the scan flow.
//
// NOTE: every internal import below carries a `?v=...` query. ES module URLs
// are cached aggressively by browsers — bumping this version invalidates all
// cached modules in one go, which is essential when shipping data-source or
// behaviour changes from a static host. Bump on any breaking change.

import { $, $$, escapeHtml, vibe } from './util.js?v=48';
import {
  state, getBenchmark, getUnitPref, setUnitPref,
  loadSession, createSession, switchSession, startPolling,
  fetchSessionSnapshot, getRecentSessions, forgetSessionLocal,
} from './state.js?v=48';
import {
  render, openAddModal, openPresetsModal, openSessionsModal, closeModal,
  submitCustomDrink, submitNewPreset, updateEthanolPreview,
  prefillCustomForm, logDrink, getAddModalPersonIdx,
  updateSaveAsPresetCopy, toggleCompareDetail,
  openEditModal, submitEditDrink, saveEditFlavourOnly, updateEditEthanolPreview,
  openNewSessionModal, hydrateCommentForm, submitMainComment, updateCommentTextarea,
} from './ui.js?v=48';
import { startScanner, barcodeScannerAvailable } from './scanner.js?v=48';
import { loadProducts, lookupUpc as lookupBcLiquor, productsLoaded } from './products.js?v=48';
import { ML_PER_OZ } from './calc.js?v=48';

console.log('Beer Converter build v48 (edit drink types from menu)');

const SESSION_AUTO_OPEN_MS = 8 * 60 * 60 * 1000;

// Kick off the BC Liquor catalogue load eagerly so it's usually warm by the
// time the user finishes scanning. Failures are logged but non-fatal — the
// user can still add the product manually.
loadProducts().catch(() => { /* already logged inside loadProducts */ });

// --- Theme toggle ---------------------------------------------------------
// Two themes: "bar" (default, dark) and "beach" (light, for sunny patios).
// Saved per-device in localStorage so it persists across sessions.
const THEME_KEY = 'beerConverter.theme';
const THEME_COLOURS = { bar: '#17110a', beach: '#f3e6c7' };

function applyTheme(theme) {
  const t = theme === 'beach' ? 'beach' : 'bar';
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOURS[t]);
  const btn = $('#btnTheme');
  if (btn) btn.title = t === 'beach' ? 'Switch to bar mode' : 'Switch to beach mode';
}

applyTheme(localStorage.getItem(THEME_KEY) || 'bar');

$('#btnTheme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'beach' ? 'bar' : 'beach';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  vibe(8);
});

// --- Unit toggle (ml / oz) -------------------------------------------------
function applyUnit(u) {
  const btn = $('#btnUnit');
  if (btn) btn.textContent = u === 'oz' ? 'OZ' : 'ML';
}

applyUnit(getUnitPref());

$('#btnUnit').addEventListener('click', () => {
  const next = getUnitPref() === 'oz' ? 'ml' : 'oz';
  setUnitPref(next);
  applyUnit(next);
  vibe(8);
  render();
});

// --- Header actions -------------------------------------------------------
$('#btnSessions').addEventListener('click', openSessionsModal);
$('#btnCurrentSession').addEventListener('click', openSessionsModal);
$('#btnNewSession').addEventListener('click', openNewSessionModal);

$('#btnPresets').addEventListener('click', openPresetsModal);

// Share button: copy the current page URL (which already carries ?s=<sid>)
// to the clipboard. Brief icon flash confirms; falls back to a prompt() on
// browsers that block clipboard writes.
$('#btnShareLink').addEventListener('click', async () => {
  const btn = $('#btnShareLink');
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1600);
    vibe(8);
  } catch {
    prompt('Copy this link to share the session:', url);
  }
});

$('#lnkChangelog').addEventListener('click', e => {
  e.preventDefault();
  $('#changelogModal').classList.add('open');
});

$('#btnReport').addEventListener('click', () => {
  if (!state.sid) return;
  if (!state.people.some(p => p.drinks.length > 0)) {
    alert('Log some drinks first — nothing to report yet!');
    return;
  }
  // Report fetches the session live by id — no base64 blob, no copy of state.
  const a = Object.assign(document.createElement('a'), {
    href: state.publicId
      ? 'report/?r=' + encodeURIComponent(state.publicId)
      : 'report/?s=' + encodeURIComponent(state.sid),
    target: '_blank', rel: 'noopener noreferrer',
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// Toggle the "compare everyone" detail panel under the tally strip.
$('#compareExpandBtn').addEventListener('click', toggleCompareDetail);

hydrateCommentForm();
$('#commentText').addEventListener('input', updateCommentTextarea);
$('#commentForm').addEventListener('submit', e => {
  e.preventDefault();
  submitMainComment();
});

// --- Global modal close wiring -------------------------------------------
// `data-close`         — closes every overlay (top-level modals)
// `data-close-scanner` — closes only the scanner overlay and stops the camera
$$('[data-close]').forEach(el => el.addEventListener('click', () => {
  stopActiveScanner();
  closeModal();
  render();
}));
$$('[data-close-scanner]').forEach(el => el.addEventListener('click', () => {
  stopActiveScanner();
  closeScannerOnly();
}));
$$('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => {
    if (e.target !== m) return;
    if (m.id === 'sessionGateModal') return;
    // Backdrop click: scanner only closes itself; other modals close fully.
    if (m.id === 'scannerModal') { stopActiveScanner(); closeScannerOnly(); }
    else { stopActiveScanner(); closeModal(); render(); }
  });
});

// --- Add-drink modal ------------------------------------------------------
function convertVolumeField(inputId, newUnit) {
  const input = $(inputId);
  const val = parseFloat(input.value);
  if (!isFinite(val) || val <= 0) return;
  if (newUnit === 'oz') {
    input.value = +(val / ML_PER_OZ).toFixed(2);
  } else {
    input.value = Math.round(val * ML_PER_OZ);
  }
}

$('#customVolume').addEventListener('input', updateEthanolPreview);
$('#customAbv').addEventListener('input', updateEthanolPreview);
$('#customUnit').addEventListener('change', e => { setUnitPref(e.target.value); applyUnit(e.target.value); convertVolumeField('#customVolume', e.target.value); updateEthanolPreview(); });
$('#btnAddCustom').addEventListener('click', submitCustomDrink);
// Keep the "Save as type" toggle copy/hint honest as the user types.
$('#customName').addEventListener('input', updateSaveAsPresetCopy);
$('#customUpc').addEventListener('input', updateSaveAsPresetCopy);
$('#saveAsPreset').addEventListener('change', updateSaveAsPresetCopy);

// --- Edit drink modal -----------------------------------------------------
$('#editVolume').addEventListener('input', updateEditEthanolPreview);
$('#editAbv').addEventListener('input', updateEditEthanolPreview);
$('#editUnit').addEventListener('change', e => { setUnitPref(e.target.value); applyUnit(e.target.value); convertVolumeField('#editVolume', e.target.value); updateEditEthanolPreview(); });
$('#btnSaveEditDrink').addEventListener('click', submitEditDrink);
$('#btnSaveEditFlavour').addEventListener('click', saveEditFlavourOnly);

// --- Presets modal --------------------------------------------------------
$('#btnAddPreset').addEventListener('click', submitNewPreset);
$('#newPresetUnit').addEventListener('change', e => { setUnitPref(e.target.value); applyUnit(e.target.value); convertVolumeField('#newPresetVolume', e.target.value); });

// --- Scanner flow ---------------------------------------------------------
let activeScanner = null;
// What to do when a UPC is found. Defaults to the add-drink flow; the
// preset-modal scan button swaps in its own handler that just fills an input.
let scannerOnFound = handleUpcFound;

function stopActiveScanner() {
  if (activeScanner) { activeScanner.stop(); activeScanner = null; }
}

function closeScannerOnly() {
  $('#scannerModal').classList.remove('open');
  // Reset to the default flow so a stale preset-input handler doesn't
  // intercept the next scan.
  scannerOnFound = handleUpcFound;
}

function setScannerStatus(text, variant = '') {
  const el = $('#scannerStatus');
  el.textContent = text;
  el.className = 'scanner-status ' + variant;
}

async function openScanner(onFound, statusMsg) {
  scannerOnFound = onFound || handleUpcFound;
  $('#scannerModal').classList.add('open');
  $('#manualUpcField').style.display = 'none';
  $('#btnManualLookup').style.display = 'none';
  $('#manualUpc').value = '';

  if (!barcodeScannerAvailable()) {
    setScannerStatus('Camera scanning not supported here. Enter a UPC manually:', 'err');
    $('#manualUpcField').style.display = '';
    $('#btnManualLookup').style.display = '';
    return;
  }

  setScannerStatus('Requesting camera…');

  let errored = false;
  activeScanner = await startScanner($('#scannerVideo'), {
    onFound: (upc) => scannerOnFound(upc),
    onError: (err) => {
      errored = true;
      console.warn('Scanner error', err);
      setScannerStatus('Could not start camera. Enter a UPC manually:', 'err');
      $('#manualUpcField').style.display = '';
      $('#btnManualLookup').style.display = '';
    },
  });

  if (!errored) {
    setScannerStatus(statusMsg || 'Point the camera at a UPC/EAN barcode…');
  }
}

$('#btnOpenScanner').addEventListener('click', () => openScanner(handleUpcFound));

$('#btnManualLookup').addEventListener('click', () => {
  const upc = $('#manualUpc').value.trim();
  if (!upc) return;
  scannerOnFound(upc);
});

// (The preset-modal "scan barcode into popover" path was removed in Phase 2
// along with the per-device UPC cache — barcodes now flow through the
// shared catalogue via /submit when a drink is logged.)

async function handleUpcFound(upc) {
  vibe(25);
  stopActiveScanner();
  setScannerStatus(`Found ${upc}. Looking up…`, 'working');

  // BC Liquor catalogue (bundled CSV) + curated entries. The old per-device
  // UPC→preset cache went away with Phase 2 — every scan goes through the
  // shared catalogue now.
  if (!productsLoaded()) {
    try { await loadProducts(); } catch { /* fall through; lookup will miss */ }
  }
  const info = lookupBcLiquor(upc);
  if (info) {
    // Category-aware prefill. For beer & coolers the catalogue volume IS the
    // drink (a 355 ml can is one drink). For spirits & wine the catalogue
    // volume is the *bottle* (750 ml etc.) — a single drink is a pour from
    // it, so we leave the volume blank and just hint a typical pour size.
    //
    // Curated entries skip this guesswork: a human entered the volume, so
    // it's the per-drink volume by definition.
    const cat = (info.category || '').toLowerCase();
    const containerIsDrink = info.curated || cat === 'beer' || cat === 'refreshment beverages';
    const pourHint =
      cat === 'spirits' ? 44 :   // ~1.5 oz shot
      cat === 'wine'    ? 142 :  // ~5 oz pour
      null;

    prefillCustomForm({
      name: info.name || '',
      volumeMl: containerIsDrink ? info.volumeMl : null,
      abv: info.abv,
      upc,
      volumePlaceholder: containerIsDrink ? null : pourHint,
      // Only curated entries carry flavour. BC Liquor entries don't.
      flavour: info.flavour || '',
    });

    // Echo the parsed values in the status line so it's obvious on screen
    // exactly what was prefilled (and to make it clear if the form somehow
    // didn't pick them up).
    const abvStr = `${(+info.abv).toFixed(1)}%`;
    const volStr = containerIsDrink ? ` · ${Math.round(info.volumeMl)} ml` : '';
    const flavStr = info.flavour ? ` · ${info.flavour}` : '';
    const tail   = containerIsDrink ? '' : ' · set pour size';
    setScannerStatus(
      `Found: ${info.name}${flavStr} · ${abvStr}${volStr}${tail}`,
      'ok',
    );
    setTimeout(closeScannerOnly, 800);
    return;
  }

  // Not found anywhere — user fills it in. Saving as a drink type adds it
  // to this session's preset list so other contributors can use it too.
  setScannerStatus("Not in the catalogue. Fill it in below — saving as a type makes it available to everyone in this session.", 'err');
  prefillCustomForm({ upc });
  $('#saveAsPreset').checked = true;
  setTimeout(closeScannerOnly, 1400);
}

// --- iOS double-tap zoom guard on controls --------------------------------
document.addEventListener('dblclick', e => {
  if (e.target.closest('button, .preset-chip, .x-btn')) e.preventDefault();
}, { passive: false });

// --- Boot ------------------------------------------------------------------
// Bare visits are intentionally explicit once a trip is stale. Direct links to
// already-known sessions still open immediately; new shared links pause first
// so it is clear that the link is a live tally.

function recentSessionsByLastSeen() {
  const seen = new Set();
  return getRecentSessions()
    .filter(rec => {
      if (!rec?.sid || seen.has(rec.sid)) return false;
      seen.add(rec.sid);
      return true;
    })
    .sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
}

function hasKnownSession(sid) {
  return getRecentSessions().some(rec => rec?.sid === sid);
}

function isFreshRecent(rec) {
  const lastSeen = Number(rec?.lastSeen) || 0;
  return lastSeen > 0 && Date.now() - lastSeen < SESSION_AUTO_OPEN_MS;
}

function sessionDisplayTime(ts) {
  const n = Number(ts) || Date.parse(ts || '');
  const d = new Date(Number.isFinite(n) && n > 0 ? n : Date.now());
  return d.toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function sessionOption(raw = {}) {
  const sid = raw.sid || raw.id || '';
  const peopleNames = Array.isArray(raw.peopleNames)
    ? raw.peopleNames.filter(Boolean)
    : Array.isArray(raw.people)
      ? raw.people.map(p => p?.name).filter(Boolean)
      : [];
  const drinkCount = Number.isFinite(Number(raw.drinkCount))
    ? Number(raw.drinkCount)
    : Array.isArray(raw.drinks)
      ? raw.drinks.length
      : 0;
  const lastSeen = Number(raw.lastSeen) || Date.parse(raw.updatedAt || raw.createdAt || '') || Date.now();
  return {
    sid,
    name: raw.name || sid || 'Session',
    peopleNames,
    drinkCount,
    lastSeen,
  };
}

function sessionPeopleLine(opt) {
  return opt.peopleNames.length ? opt.peopleNames.join(' · ') : '(no one yet)';
}

function sessionMetaLine(opt) {
  const drinks = Number(opt.drinkCount) || 0;
  return `${sessionDisplayTime(opt.lastSeen)} · ${drinks} drink${drinks === 1 ? '' : 's'}`;
}

function sessionGateList(recents, { markLatest = false } = {}) {
  if (!recents.length) return '';
  return `
    <div class="session-list session-gate-list">
      ${recents.map((rec, idx) => {
        const opt = sessionOption(rec);
        const people = sessionPeopleLine(opt);
        const badge = markLatest && idx === 0 ? ' <span class="session-badge">latest</span>' : '';
        return `
          <div class="session-item session-gate-item">
            <div class="session-item-info">
              <div class="session-item-name">${escapeHtml(opt.name)}${badge}</div>
              <div class="session-item-people" title="${escapeHtml(people)}">${escapeHtml(people)}</div>
              <div class="session-item-meta">${escapeHtml(sessionMetaLine(opt))}</div>
            </div>
            <button class="btn btn-ghost session-switch-btn" data-gate-open-session="${escapeHtml(opt.sid)}">open</button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function sessionGateSummary(raw) {
  const opt = sessionOption(raw);
  const people = sessionPeopleLine(opt);
  return `
    <div class="session-gate-summary">
      <div class="session-gate-summary-name">${escapeHtml(opt.name)}</div>
      <div class="session-item-people" title="${escapeHtml(people)}">${escapeHtml(people)}</div>
      <div class="session-item-meta">${escapeHtml(sessionMetaLine(opt))}</div>
    </div>
  `;
}

function setSessionGateStatus(text = '', variant = '') {
  const el = $('#sessionGateStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'session-gate-status' + (variant ? ` ${variant}` : '');
}

function showSessionGate(title, bodyHtml, { statusText = '', statusVariant = '' } = {}) {
  $('#sessionGateTitle').textContent = title;
  $('#sessionGateBody').innerHTML = bodyHtml;
  setSessionGateStatus(statusText, statusVariant);
  const modal = $('#sessionGateModal');
  modal.classList.add('open');
  wireSessionGateActions();
  requestAnimationFrame(() => (modal.querySelector('.btn-primary') || modal.querySelector('button'))?.focus());
}

function closeSessionGate() {
  $('#sessionGateModal')?.classList.remove('open');
}

function wireSessionGateActions() {
  const body = $('#sessionGateBody');
  body.querySelectorAll('[data-gate-create-session]').forEach(btn => {
    btn.addEventListener('click', () => createGateSession(btn));
  });
  body.querySelectorAll('[data-gate-open-session]').forEach(btn => {
    btn.addEventListener('click', () => switchSession(btn.dataset.gateOpenSession));
  });
  body.querySelectorAll('[data-gate-join-session]').forEach(btn => {
    btn.addEventListener('click', () => enterSessionFromGate(btn.dataset.gateJoinSession, btn));
  });
  body.querySelectorAll('[data-gate-retry-session]').forEach(btn => {
    btn.addEventListener('click', () => showSharedSessionGate(btn.dataset.gateRetrySession));
  });
}

async function createGateSession(btn) {
  if (btn) btn.disabled = true;
  setSessionGateStatus('Creating session...');
  try {
    const sid = await createSession({});
    switchSession(sid);
  } catch (e) {
    console.error('initial session creation failed', e);
    setSessionGateStatus('Could not reach the server. Try again.', 'err');
    if (btn) btn.disabled = false;
  }
}

async function enterSession(sid) {
  await loadSession(sid);
  closeSessionGate();
  render();
  startPolling(render);
}

async function enterSessionFromGate(sid, btn) {
  if (!sid) return;
  if (btn) btn.disabled = true;
  setSessionGateStatus('Opening session...');
  try {
    await enterSession(sid);
  } catch (e) {
    if (e?.status === 404) {
      forgetSessionLocal(sid);
      showMissingSessionGate();
      return;
    }
    console.error('loadSession failed', e);
    setSessionGateStatus('Could not load that session. Try again.', 'err');
    if (btn) btn.disabled = false;
  }
}

function showFirstSessionGate() {
  showSessionGate('Start your first session', `
    <p class="session-gate-copy">
      A session is the live tally for one outing. It gets its own link, and anyone with that link contributes to the same count.
    </p>
    <div class="actions">
      <button class="btn btn-primary" data-gate-create-session>Start first session</button>
    </div>
  `);
}

function showChooseSessionGate(recents = recentSessionsByLastSeen()) {
  showSessionGate('Choose a session', `
    <p class="session-gate-copy">
      It has been a while since this device opened Beer Converter. Continue a saved live tally or start a clean one.
    </p>
    ${sessionGateList(recents, { markLatest: true })}
    <div class="actions">
      <button class="btn btn-primary" data-gate-create-session>Start new session</button>
    </div>
  `);
}

function showMissingSessionGate() {
  const recents = recentSessionsByLastSeen();
  const copy = recents.length
    ? 'That link does not point to a live session anymore. Start a new tally, or open one saved on this device.'
    : 'That link does not point to a live session anymore. Start a new tally to keep going.';
  showSessionGate('Session not found', `
    <p class="session-gate-copy">
      ${escapeHtml(copy)}
    </p>
    ${sessionGateList(recents)}
    <div class="actions">
      <button class="btn btn-primary" data-gate-create-session>Start new session</button>
    </div>
  `);
}

function showSessionLoadErrorGate(sid) {
  showSessionGate('Could not reach session', `
    <p class="session-gate-copy">
      The app could not load this session. Check the connection, then try again.
    </p>
    <div class="actions">
      <button class="btn btn-ghost" data-gate-create-session>Start new session</button>
      <button class="btn btn-primary" data-gate-retry-session="${escapeHtml(sid)}">Try again</button>
    </div>
  `);
}

async function showSharedSessionGate(sid) {
  showSessionGate('Opening shared link', `
    <p class="session-gate-copy">
      Checking the live session before adding it to this device.
    </p>
  `, { statusText: 'Loading session...' });

  try {
    const snapshot = await fetchSessionSnapshot(sid);
    showSessionGate('Open shared session?', `
      <p class="session-gate-copy">
        This link is a live shared tally. Opening it adds the session to this device so you can switch back later.
      </p>
      ${sessionGateSummary(snapshot)}
      <div class="actions">
        <button class="btn btn-ghost" data-gate-create-session>Start new instead</button>
        <button class="btn btn-primary" data-gate-join-session="${escapeHtml(sid)}">Open live session</button>
      </div>
    `);
  } catch (e) {
    if (e?.status === 404) {
      forgetSessionLocal(sid);
      showMissingSessionGate();
      return;
    }
    console.error('shared session preview failed', e);
    showSessionLoadErrorGate(sid);
  }
}

function handleSessionLoadFailure(sid, e) {
  if (e?.status === 404) {
    forgetSessionLocal(sid);
    showMissingSessionGate();
    return;
  }
  console.error('loadSession failed', e);
  showSessionLoadErrorGate(sid);
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('s');

  if (!sid) {
    const recents = recentSessionsByLastSeen();
    if (!recents.length) {
      showFirstSessionGate();
      return;
    }
    if (isFreshRecent(recents[0])) {
      switchSession(recents[0].sid);
      return;
    }
    showChooseSessionGate(recents);
    return;
  }

  if (!hasKnownSession(sid)) {
    await showSharedSessionGate(sid);
    return;
  }

  try { await enterSession(sid); }
  catch (e) { handleSessionLoadFailure(sid, e); }
}

boot();
