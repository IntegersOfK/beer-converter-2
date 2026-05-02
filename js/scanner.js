// UPC scanning via the native BarcodeDetector API. No backend required.
//
// Supported in:
//   - Chrome for Android
//   - Chrome / Edge on desktop
//   - Safari on iOS 17+
// Firefox does not ship it yet (the UI falls back to manual UPC entry).
//
// Product lookup is handled separately by ./products.js (BC Liquor catalogue)
// and ./state.js (the user's local UPC cache).

import { ML_PER_OZ } from './calc.js';

// --- volume parsing helpers (used by manual entry / future imports) --------
// Inputs seen in practice:
//   "473 ml", "1.5 L", "12 fl oz", "16 oz", "6 x 355 ml", "355ml", "50 cl"
export function parseVolumeToMl(str) {
  if (!str) return null;
  const s = String(str).toLowerCase().replace(/,/g, '.');

  // If it's a multipack like "6 x 355 ml", just take the per-unit volume.
  const multi = s.match(/\d+\s*[x×]\s*(\d+(?:\.\d+)?)\s*(ml|l|cl|fl\s*oz|oz)/i);
  if (multi) return normalizeVolume(parseFloat(multi[1]), multi[2]);

  const single = s.match(/(\d+(?:\.\d+)?)\s*(ml|l|cl|fl\s*oz|oz)/i);
  if (single) return normalizeVolume(parseFloat(single[1]), single[2]);

  return null;
}

function normalizeVolume(value, unit) {
  if (!isFinite(value) || value <= 0) return null;
  const u = unit.replace(/\s+/g, '').toLowerCase();
  if (u === 'ml') return value;
  if (u === 'l')  return value * 1000;
  if (u === 'cl') return value * 10;
  if (u === 'oz' || u === 'floz') return value * ML_PER_OZ;
  return null;
}

// --- Camera scanning -------------------------------------------------------
export function barcodeScannerAvailable() {
  return 'BarcodeDetector' in window;
}

// Starts a live scan on a <video> element. Returns an object with a stop()
// method and resolves onFound(code) once a barcode is detected.
export async function startScanner(videoEl, { onFound, onError }) {
  if (!barcodeScannerAvailable()) {
    onError?.(new Error('BarcodeDetector not supported in this browser'));
    return { stop: () => {} };
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    onError?.(e);
    return { stop: () => {} };
  }

  videoEl.srcObject = stream;
  try { await videoEl.play(); } catch (e) { /* user gesture required on some browsers */ }

  const detector = new BarcodeDetector({
    formats: ['upc_a', 'upc_e', 'ean_8', 'ean_13', 'code_128', 'code_39'],
  });

  let stopped = false;
  let rafId = null;

  async function tick() {
    if (stopped) return;
    try {
      const codes = await detector.detect(videoEl);
      if (codes && codes.length > 0) {
        const raw = codes[0].rawValue;
        if (raw) {
          stopped = true;
          cleanup();
          onFound?.(raw);
          return;
        }
      }
    } catch (e) {
      // transient decode errors are normal; keep going
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  function cleanup() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    try { videoEl.pause(); } catch {}
    videoEl.srcObject = null;
    stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }

  return { stop: cleanup };
}
