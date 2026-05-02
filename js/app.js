// Entry point. Wires DOM events to state + UI, and orchestrates the scan flow.

import { $, $$, vibe } from './util.js';
import { state, clearAllDrinks, getPresetIdForUpc } from './state.js';
import {
  render, openAddModal, openPresetsModal, closeModal,
  submitCustomDrink, submitNewPreset, updateEthanolPreview,
  prefillCustomForm, logDrink, getAddModalPersonIdx,
} from './ui.js';
import { startScanner, barcodeScannerAvailable } from './scanner.js';
import { loadProducts, lookupUpc as lookupBcLiquor, productsLoaded } from './products.js';

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
    setScannerStatus('Found in BC Liquor catalogue. Review & add.', 'ok');
    prefillCustomForm({
      name: info.name || '',
      volumeMl: info.volumeMl,
      abv: info.abv,
      upc,
    });
    setTimeout(closeScannerOnly, 600);
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
