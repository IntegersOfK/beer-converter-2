// Entry point. Wires DOM events to state + UI, and orchestrates the scan flow.
//
// NOTE: every internal import below carries a `?v=...` query. ES module URLs
// are cached aggressively by browsers — bumping this version invalidates all
// cached modules in one go, which is essential when shipping data-source or
// behaviour changes from a static host. Bump on any breaking change.

import { $, $$, vibe } from './util.js?v=2';
import { state, clearAllDrinks, getPresetIdForUpc } from './state.js?v=2';
import {
  render, openAddModal, openPresetsModal, closeModal,
  submitCustomDrink, submitNewPreset, updateEthanolPreview,
  prefillCustomForm, logDrink, getAddModalPersonIdx,
} from './ui.js?v=2';
import { startScanner, barcodeScannerAvailable } from './scanner.js?v=2';
import { loadProducts, lookupUpc as lookupBcLiquor, productsLoaded } from './products.js?v=2';

// Visible build marker so you can confirm the new bundle is loaded:
// open DevTools → Console → look for "Beer Converter build v2 (BC Liquor)".
console.log('Beer Converter build v2 (BC Liquor catalogue, no third-party API)');

// Kick off the BC Liquor catalogue load eagerly so it's usually warm by the
// time the user finishes scanning. Failures are logged but non-fatal — the
// user can still add the product manually.
loadProducts().catch(() => { /* already logged inside loadProducts */ });

// --- Header actions -------------------------------------------------------
$('#btnPresets').addEventListener('click', openPresetsModal);

$('#btnReset').addEventListener('click', () => {
  const any = state.people.some(p => p.drinks.length > 0);
  if (!any) return;
  if (!confirm('Clear all drinks for both people?')) return;
  clearAllDrinks();
  render();
});

// --- Global modal close wiring -------------------------------------------
// `data-close`         — closes every overlay (top-level modals)
// `data-close-scanner` — closes only the scanner overlay and stops the camera
$$('[data-close]').forEach(el => el.addEventListener('click', () => {
  stopActiveScanner();
  closeModal();
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
    else { stopActiveScanner(); closeModal(); }
  });
});

// --- Add-drink modal ------------------------------------------------------
$('#customVolume').addEventListener('input', updateEthanolPreview);
$('#customAbv').addEventListener('input', updateEthanolPreview);
$('#customUnit').addEventListener('change', updateEthanolPreview);
$('#btnAddCustom').addEventListener('click', submitCustomDrink);

// --- Presets modal --------------------------------------------------------
$('#btnAddPreset').addEventListener('click', submitNewPreset);

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
  // Instant add.
  const cachedId = getPresetIdForUpc(upc);
  if (cachedId) {
    const preset = state.presets.find(p => p.id === cachedId);
    if (preset) {
      const idx = getAddModalPersonIdx();
      logDrink(idx, { name: preset.name, volumeMl: preset.volumeMl, abv: preset.abv, presetId: preset.id });
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
    const cat = (info.category || '').toLowerCase();
    const containerIsDrink = cat === 'beer' || cat === 'refreshment beverages';
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
    });

    // Echo the parsed values in the status line so it's obvious on screen
    // exactly what was prefilled (and to make it clear if the form somehow
    // didn't pick them up).
    const abvStr = `${(+info.abv).toFixed(1)}%`;
    const volStr = containerIsDrink ? ` · ${Math.round(info.volumeMl)} ml` : '';
    const tail   = containerIsDrink ? '' : ' · set pour size';
    setScannerStatus(
      `Found: ${info.name} · ${abvStr}${volStr}${tail}`,
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
