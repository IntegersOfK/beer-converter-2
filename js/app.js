// Entry point. Wires DOM events to state + UI, and orchestrates the scan flow.
//
// NOTE: every internal import below carries a `?v=...` query. ES module URLs
// are cached aggressively by browsers — bumping this version invalidates all
// cached modules in one go, which is essential when shipping data-source or
// behaviour changes from a static host. Bump on any breaking change.

import { $, $$, vibe } from './util.js?v=39';
import {
  state, clearAllDrinks, getBenchmark, getUnitPref, setUnitPref,
  loadSession, createSession, switchSession, startPolling,
  getRecentSessions, forgetSessionLocal,
} from './state.js?v=39';
import {
  render, openAddModal, openPresetsModal, openSessionsModal, closeModal,
  submitCustomDrink, submitNewPreset, updateEthanolPreview,
  prefillCustomForm, logDrink, getAddModalPersonIdx,
  updateSaveAsPresetCopy, toggleCompareDetail,
  openEditModal, submitEditDrink, saveEditFlavourOnly, updateEditEthanolPreview,
} from './ui.js?v=39';
import { startScanner, barcodeScannerAvailable } from './scanner.js?v=39';
import { loadProducts, lookupUpc as lookupBcLiquor, productsLoaded } from './products.js?v=39';
import { ML_PER_OZ } from './calc.js?v=39';

console.log('Beer Converter build v39 (api base paths)');

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
$('#btnNewSession').addEventListener('click', async () => {
  // Optional preset import: if there are other sessions in the recents
  // list, offer to copy types from the most recent. Skip the prompt for
  // first-time users so the friction stays at zero.
  const others = getRecentSessions().filter(s => s.sid !== state.sid);
  let importFrom = null;
  if (others.length > 0) {
    const pick = others[0];
    if (confirm(`Copy drink types from "${pick.name}"?`)) importFrom = pick.sid;
  }
  try {
    const sid = await createSession({ importPresetsFromSid: importFrom });
    switchSession(sid);   // navigates; full reload picks up the new session
  } catch (e) { console.error('newSession failed', e); alert('New session failed'); }
});

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
    href: 'report.html?s=' + encodeURIComponent(state.sid),
    target: '_blank', rel: 'noopener noreferrer',
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

// Toggle the "compare everyone" detail panel under the tally strip.
$('#compareExpandBtn').addEventListener('click', toggleCompareDetail);

$('#btnReset').addEventListener('click', () => {
  const any = state.people.some(p => p.drinks.length > 0);
  if (!any) return;
  if (!confirm('Clear all logged drinks for everyone?')) return;
  clearAllDrinks();
  render();
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
// The app always opens "into" a server-side session via ?s=<sid>. If the
// URL has none we redirect — to the most recent session in localStorage if
// any, else create a fresh one. This means a bare visit to bc.ajwest.ca
// always lands in a valid session within one round trip.

async function boot() {
  const params = new URLSearchParams(location.search);
  const sid = params.get('s');

  if (!sid) {
    const recents = getRecentSessions();
    if (recents.length > 0) {
      switchSession(recents[0].sid);   // navigates
      return;
    }
    try {
      const newSid = await createSession({});
      switchSession(newSid);
    } catch (e) {
      console.error('initial session creation failed', e);
      document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#a08d6e;font-family:Fraunces,serif;">Could not reach the server. Try refreshing.</div>';
    }
    return;
  }

  try {
    await loadSession(sid);
  } catch (e) {
    if (e?.status === 404) {
      // Session was deleted server-side. Drop it from recents and start fresh.
      forgetSessionLocal(sid);
      try { const newSid = await createSession({}); switchSession(newSid); } catch {}
      return;
    }
    console.error('loadSession failed', e);
    alert('Could not load session — refreshing in 3 seconds.');
    setTimeout(() => location.reload(), 3000);
    return;
  }

  render();
  startPolling(render);
}

boot();
