// BC Liquor product catalogue lookup.
//
// Loads the SQLite-backed public catalogue once per session, indexes it by
// UPC, and answers `lookupUpc(upc)` synchronously after `loadProducts()` has
// resolved.
//
// We index by raw UPC AND a normalised (digits-only, leading zeros stripped)
// form so a scanner returning "087000007604" matches a catalogue UPC
// "87000007604".

import { API_BASE } from './api.js?v=47';

const CATALOG_URL = API_BASE + '/catalog.json';

let _byUpc = null;          // Map<string, Product>
let _loadPromise = null;    // de-dupes concurrent loads

// --- public API -------------------------------------------------------------

export function productsLoaded() { return _byUpc !== null; }

// All distinct flavours we know about for a given product name. Used by the
// edit-drink modal to autocomplete the Flavour input. Names match exactly
// (case-sensitive) since that's how the curated model groups variants.
export function getFlavoursForName(name) {
  if (!_byUpc || !name) return [];
  const seen = new Set();
  const out = [];
  for (const product of _byUpc.values()) {
    if (product.name !== name || !product.flavour) continue;
    // _byUpc has multiple keys pointing at the same object; dedupe by ref.
    if (seen.has(product)) continue;
    seen.add(product);
    out.push(product.flavour);
  }
  // Dedupe identical flavour strings across distinct UPC entries (rare but
  // possible if the curator linked two UPCs of the same flavour).
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

export function loadProducts() {
  if (_byUpc) return Promise.resolve();
  if (_loadPromise) return _loadPromise;

  _loadPromise = fetch(CATALOG_URL, { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('catalog fetch failed: ' + r.status); return r.json(); })
    .then(catalogue => {
      const map = new Map();
      mergeCatalogue(map, Array.isArray(catalogue) ? catalogue : []);
      _byUpc = map;
    })
    .catch(err => {
      console.warn('BC Liquor catalogue failed to load', err);
      _byUpc = new Map();
    });
  return _loadPromise;
}

function mergeCatalogue(map, catalogue) {
  for (const c of catalogue) {
    if (!c || typeof c.upc !== 'string') continue;
    const product = {
      upc:         c.upc,
      name:        typeof c.name === 'string' ? c.name : '',
      volumeMl:    Number.isFinite(+c.volumeMl) ? +c.volumeMl : null,
      abv:         Number.isFinite(+c.abv) ? +c.abv : null,
      category:    typeof c.category === 'string' ? c.category : null,
      subcategory: typeof c.subcategory === 'string' ? c.subcategory : null,
      productId:   typeof c.productId === 'string' ? c.productId : null,
      flavour:     typeof c.flavour === 'string' && c.flavour.trim() ? c.flavour.trim() : null,
      curated:     Boolean(c.curated),
    };
    indexProductAllForms(map, product);
  }
}

function indexProductAllForms(map, product) {
  const upc = product.upc;
  map.set(upc, product);
  const digits = upc.replace(/\D/g, '');
  if (digits && digits !== upc)        map.set(digits, product);
  const stripped = digits.replace(/^0+/, '');
  if (stripped && stripped !== digits) map.set(stripped, product);
}

// Synchronous lookup. Returns a normalised product object or null.
// Caller should ensure loadProducts() has resolved first; if it hasn't,
// this will simply miss (returns null).
export function lookupUpc(upc) {
  if (!upc || !_byUpc) return null;
  const raw = String(upc).trim();
  if (!raw) return null;
  // Try the exact string first, then digits-only with various leading-zero
  // forms — UPC-A scans often arrive as 13-digit EAN with a leading zero.
  if (_byUpc.has(raw)) return _byUpc.get(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits && _byUpc.has(digits)) return _byUpc.get(digits);
  const stripped = digits.replace(/^0+/, '');
  if (stripped && _byUpc.has(stripped)) return _byUpc.get(stripped);
  return null;
}
