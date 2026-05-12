// BC Liquor product catalogue lookup.
//
// Fetches the live catalogue from /catalog.json once per session and indexes
// it by UPC for synchronous lookup after `loadProducts()` has resolved. The
// server is authoritative: rows come from a JOIN of the curated `products`
// and `upcs` tables (BC Liquor SKUs are imported into the DB at server
// startup; there is no CSV asset shipped to the browser anymore).
//
// Catalogue row shape:
//   { upc, productId, name, volumeMl, abv, flavour, category, curated }
//
// We index each row under raw, digits-only, and leading-zero-stripped UPC
// forms so a scanner returning "087000007604" still matches a stored
// "87000007604".

import { API_BASE } from './api.js?v=54';

const CATALOG_URL = API_BASE + '/catalog.json';

let _byUpc = null;          // Map<string, Product>
let _loadPromise = null;    // de-dupes concurrent loads

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
    if (seen.has(product)) continue;
    seen.add(product);
    out.push(product.flavour);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

export function loadProducts() {
  if (_byUpc) return Promise.resolve();
  if (_loadPromise) return _loadPromise;

  _loadPromise = fetch(CATALOG_URL, { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error('catalog fetch failed: ' + r.status); return r.json(); })
    .catch(err => { console.warn('Catalogue failed to load', err); return []; })
    .then(rows => { _byUpc = buildIndex(Array.isArray(rows) ? rows : []); });

  return _loadPromise;
}

function buildIndex(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row.upc !== 'string') continue;
    const product = normaliseRow(row);
    if (!product) continue;
    indexProductAllForms(map, product);
  }
  return map;
}

function normaliseRow(row) {
  const upc = String(row.upc).trim();
  if (!upc) return null;
  return {
    upc,
    productId:   typeof row.productId === 'string' ? row.productId : null,
    name:        typeof row.name === 'string' ? row.name : '',
    volumeMl:    Number.isFinite(+row.volumeMl) ? +row.volumeMl : null,
    abv:         Number.isFinite(+row.abv) ? +row.abv : null,
    flavour:     typeof row.flavour === 'string' && row.flavour.trim() ? row.flavour.trim() : null,
    category:    typeof row.category === 'string' ? row.category : null,
    // SQLite returns 0/1; treat any truthy value as curated.
    curated:     !!row.curated,
  };
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
  if (_byUpc.has(raw)) return _byUpc.get(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits && _byUpc.has(digits)) return _byUpc.get(digits);
  const stripped = digits.replace(/^0+/, '');
  if (stripped && _byUpc.has(stripped)) return _byUpc.get(stripped);
  return null;
}
