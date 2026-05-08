// Entry point. Wires DOM events to state + UI, and orchestrates the scan flow.
//
// NOTE: every internal import below carries a `?v=...` query. ES module URLs
// are cached aggressively by browsers — bumping this version invalidates all
// cached modules in one go, which is essential when shipping data-source or
// behaviour changes from a static host. Bump on any breaking change.

import { $, $$, vibe } from './util.js?v=32';
import { state, clearAllDrinks, getPresetIdForUpc, getBenchmark, getUnitPref, setUnitPref, newSession } from './state.js?v=32';
import {
  render, openAddModal, openPresetsModal, openSessionsModal, closeModal,
  submitCustomDrink, submitNewPreset, updateEthanolPreview,
  prefillCustomForm, logDrink, getAddModalPersonIdx,
  updateSaveAsPresetCopy, toggleCompareDetail,
  openEditModal, submitEditDrink, saveEditFlavourOnly, updateEditEthanolPreview,
} from './ui.js?v=32';
import { startScanner, barcodeScannerAvailable } from './scanner.js?v=32';
import { loadProducts, lookupUpc as lookupBcLiquor, productsLoaded } from './products.js?v=32';
import { ML_PER_OZ } from './calc.js?v=32';

// Visible build marker so you can confirm the new bundle is loaded:
// open DevTools → Console → look for the "Beer Converter build v5" line.
console.log('Beer Converter build v32 (TODO sweep: same-again, recency chips, default-checked, admin link, icons)');

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
$('#btnNewSession').addEventListener('click', () => {
  newSession();
  closeModal();
  render();
});

$('#btnPresets').addEventListener('click', openPresetsModal);

$('#btnReport').addEventListener('click', () => {
  if (!state.people.some(p => p.drinks.length > 0)) {
    alert('Log some drinks first — nothing to report yet!');
    return;
  }
  const bench = getBenchmark();
  const payload = {
    v: 1,
    ts: Date.now(),
    p: state.people.map(p => ({
      n: p.name,
      d: p.drinks.map(d => {
        const o = { n: d.name, v: +d.volumeMl.toFixed(1), a: +d.abv.toFixed(2) };
        if (d.flavour) o.f = d.flavour;
        return o;
      }),
    })),
    bm: bench ? { n: bench.name, v: bench.volumeMl, a: bench.abv } : null,
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const a = Object.assign(document.createElement('a'), {
    href: 'report.html?d=' + encoded,
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

function stopActiveScanner() {
  if (activeScanner) { activeScanner.stop(); activeScanner = null; }
}

function closeScannerOnly() {
  $('#scannerModal').classList.remove('open');
}

function setScannerStatus(text, variant = '') {
  const el = $('#scannerStatus');
  el.textContent = text;
  el.className = 'scanner-status ' + variant;
}

$('#btnOpenScanner').addEventListener('click', async () => {
  // Open the scanner modal on top of the add-drink modal. If the browser
  // can't scan, fall back to a manual UPC text input.
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

  // startScanner's onError is called synchronously before the promise settles
  // when permission/availability fails, so this flag is reliable.
  let errored = false;
  activeScanner = await startScanner($('#scannerVideo'), {
    onFound: handleUpcFound,
    onError: (err) => {
      errored = true;
      console.warn('Scanner error', err);
      setScannerStatus('Could not start camera. Enter a UPC manually:', 'err');
      $('#manualUpcField').style.display = '';
      $('#btnManualLookup').style.display = '';
    },
  });

  if (!errored) {
    setScannerStatus('Point the camera at a UPC/EAN barcode…');
  }
});

$('#btnManualLookup').addEventListener('click', () => {
  const upc = $('#manualUpc').value.trim();
  if (!upc) return;
  handleUpcFound(upc);
});

async function handleUpcFound(upc) {
  vibe(25);
  stopActiveScanner();
  setScannerStatus(`Found ${upc}. Looking up…`, 'working');

  // 1. Local cache — we've scanned this UPC before, or saved it ourselves.
  // Instant add. Flavour comes from the central catalogue (when known) so a
  // cached preset for a multi-flavour product still records WHICH flavour was
  // scanned this time, even though the preset itself stays product-level.
  const cachedId = getPresetIdForUpc(upc);
  if (cachedId) {
    const preset = state.presets.find(p => p.id === cachedId);
    if (preset) {
      const idx = getAddModalPersonIdx();
      // Look up the catalogue side-channel for flavour; non-fatal if unloaded.
      let flavour = '';
      try {
        if (productsLoaded()) {
          const cat = lookupBcLiquor(upc);
          if (cat && cat.flavour) flavour = cat.flavour;
        }
      } catch {}
      logDrink(idx, {
        name: preset.name, volumeMl: preset.volumeMl, abv: preset.abv,
        presetId: preset.id, flavour,
      }, { upc });
      closeScannerOnly();
      closeModal();
      return;
    }
  }

  // 2. BC Liquor catalogue (bundled CSV). May still be loading on a cold
  // start — wait for it before declaring a miss.
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

  // 3. Not found anywhere — user fills it in. The "save as type" toggle is
  // pre-checked so the UPC is remembered locally and the next scan is instant.
  setScannerStatus("Not in the catalogue. Fill it in below — it'll be saved on this device for next time.", 'err');
  prefillCustomForm({ upc });
  $('#saveAsPreset').checked = true;
  setTimeout(closeScannerOnly, 1400);
}

// --- iOS double-tap zoom guard on controls --------------------------------
document.addEventListener('dblclick', e => {
  if (e.target.closest('button, .preset-chip, .x-btn')) e.preventDefault();
}, { passive: false });

// --- Initial render -------------------------------------------------------
render();
