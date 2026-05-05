// BC Liquor product catalogue lookup.
//
// Loads the bundled BC Liquor Stores price-list CSV once per session,
// indexes it by UPC, and answers `lookupUpc(upc)` synchronously after
// `loadProducts()` has resolved.
//
// Source CSV: BC Liquor Distribution Branch monthly product price list.
// Columns: ITEM_CATEGORY_NAME, ITEM_SUBCATEGORY_NAME, ITEM_CLASS_NAME,
//   PRODUCT_COUNTRY_ORIGIN_NAME, PRODUCT_SKU_NO, PRODUCT_LONG_NAME,
//   PRODUCT_BASE_UPC_NO, PRODUCT_LITRES_PER_CONTAINER,
//   PRD_CONTAINER_PER_SELL_UNIT, PRODUCT_ALCOHOL_PERCENT,
//   PRODUCT_PRICE, SWEETNESS_CODE
//
// We index by raw UPC AND a normalised (digits-only, leading zeros stripped)
// form so a scanner returning "087000007604" matches a CSV "87000007604".

const CSV_PATH = 'bc_liquor_store_product_price_list_december_2025.csv';

// Crowdsourced curated catalogue. Fetched in parallel with the BC CSV; entries
// here override BC entries for the same UPC. Local dev hits the Node server
// directly; prod uses a same-origin relative path (the host reverse-proxies
// /catalog.json to the backend). Avoids the Private Network Access prompt
// that fires when a public origin tries to reach localhost.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const CATALOG_URL = IS_LOCAL ? 'http://localhost:8787/catalog.json' : '/catalog.json';

let _byUpc = null;          // Map<string, Product>
let _loadPromise = null;    // de-dupes concurrent loads

// --- public API -------------------------------------------------------------

export function productsLoaded() { return _byUpc !== null; }

export function loadProducts() {
  if (_byUpc) return Promise.resolve();
  if (_loadPromise) return _loadPromise;

  // BC CSV — required for offline-first behaviour.
  const bcLoad = fetch(CSV_PATH)
    .then(r => { if (!r.ok) throw new Error('CSV fetch failed: ' + r.status); return r.text(); })
    .then(text => buildIndex(parseCsv(text)))
    .catch(err => { console.warn('BC Liquor catalogue failed to load', err); return new Map(); });

  // Curated catalogue — optional; never block the app on it.
  const curatedLoad = !CATALOG_URL ? Promise.resolve([]) :
    fetch(CATALOG_URL, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error('catalog fetch failed: ' + r.status); return r.json(); })
      .catch(err => { console.warn('Curated catalogue failed to load', err); return []; });

  _loadPromise = Promise.all([bcLoad, curatedLoad]).then(([bcMap, curated]) => {
    // Curated entries win on conflict (the whole point of curating them).
    mergeCurated(bcMap, Array.isArray(curated) ? curated : []);
    _byUpc = bcMap;
  });
  return _loadPromise;
}

function mergeCurated(map, curated) {
  for (const c of curated) {
    if (!c || typeof c.upc !== 'string') continue;
    const product = {
      upc:         c.upc,
      name:        typeof c.name === 'string' ? c.name : '',
      volumeMl:    Number.isFinite(+c.volumeMl) ? +c.volumeMl : null,
      abv:         Number.isFinite(+c.abv) ? +c.abv : null,
      category:    null,
      subcategory: null,
      curated:     true,
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

// --- CSV parsing ------------------------------------------------------------
// Minimal RFC-4180-ish parser. Handles quoted fields, escaped quotes (""),
// and CRLF line endings. The BC Liquor file is well-formed; we don't need
// streaming or fancy error recovery.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; i++; continue;
    }
    field += ch; i++;
  }
  // last field/row (no trailing newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// --- index build ------------------------------------------------------------
function buildIndex(rows) {
  if (rows.length < 2) return new Map();
  const header = rows[0].map(h => h.trim());
  const col = name => header.indexOf(name);
  const iName  = col('PRODUCT_LONG_NAME');
  const iUpc   = col('PRODUCT_BASE_UPC_NO');
  const iLit   = col('PRODUCT_LITRES_PER_CONTAINER');
  const iAbv   = col('PRODUCT_ALCOHOL_PERCENT');
  const iCat   = col('ITEM_CATEGORY_NAME');
  const iSub   = col('ITEM_SUBCATEGORY_NAME');

  const map = new Map();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const upc = (row[iUpc] || '').trim();
    if (!upc) continue;                          // unscannable; skip
    const litres = parseFloat(row[iLit]);
    const abv = parseFloat(row[iAbv]);
    if (!isFinite(litres) || !isFinite(abv)) continue;

    const product = {
      upc,
      name: tidyName(row[iName] || ''),
      volumeMl: litres * 1000,
      abv,
      category: row[iCat] || null,
      subcategory: row[iSub] || null,
    };
    indexProductAllForms(map, product);
  }
  return map;
}

// BC Liquor uses ALL-CAPS names, often truncated and verbose.
// Title-case and trim trailing/leading separators for nicer display.
function tidyName(s) {
  const cleaned = s.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  return cleaned.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}
