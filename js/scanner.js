// UPC scanning + Open Food Facts lookup. No backend required.
//
// Uses the native BarcodeDetector API, shipped in:
//   - Chrome for Android
//   - Chrome / Edge on desktop
//   - Safari on iOS 17+
// Firefox does not ship it yet (the UI falls back to manual UPC entry).

import { ML_PER_OZ } from './calc.js';

// --- Open Food Facts lookup ------------------------------------------------
// Free, CORS-enabled. Returns normalised product info or null.
export async function lookupUpc(upc) {
  if (!upc) return null;
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(upc)}.json` +
              `?fields=product_name,product_name_en,brands,quantity,serving_size,` +
              `alcohol_by_volume_value,alcohol_by_volume_100g,nutriments`;
  let res;
  try { res = await fetch(url, { headers: { Accept: 'application/json' } }); }
  catch { return null; }
  if (!res.ok) return null;

  let data;
  try { data = await res.json(); }
  catch { return null; }

  if (data.status !== 1 || !data.product) return null;
  const p = data.product;

  return {
    upc,
    name: (p.product_name_en || p.product_name || p.brands || '').trim() || null,
    volumeMl: parseVolumeToMl(p.quantity) ?? parseVolumeToMl(p.serving_size),
    abv: pickAbv(p),
    kcalPer100ml: pickKcalPer100ml(p),
    raw: p,
  };
}

function pickAbv(p) {
  const n = p?.nutriments || {};
  const candidates = [
    p.alcohol_by_volume_value,
    n.alcohol_value,
    n['alcohol_100g'],
    p.alcohol_by_volume_100g,
  ];
  for (const v of candidates) {
    const num = parseFloat(v);
    if (isFinite(num) && num > 0 && num <= 100) return num;
  }
  return null;
}

function pickKcalPer100ml(p) {
  const n = p?.nutriments || {};
  const candidates = [
    n['energy-kcal_100ml'],
    n['energy-kcal_100g'], // close enough for beverages (~1 g/ml)
  ];
  for (const v of candidates) {
    const num = parseFloat(v);
    if (isFinite(num) && num >= 0) return num;
  }
  return null;
}

// --- quantity parsing ------------------------------------------------------
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
