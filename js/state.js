// All state, persistence, and migrations live here.

const STORAGE_KEY = 'beerConverter.v1';
const UPC_CACHE_KEY = 'beerConverter.upcCache.v1';
const UNIT_KEY = 'beerConverter.unit';

export function getUnitPref() {
  try { return localStorage.getItem(UNIT_KEY) === 'oz' ? 'oz' : 'ml'; } catch { return 'ml'; }
}
export function setUnitPref(u) {
  try { localStorage.setItem(UNIT_KEY, u === 'oz' ? 'oz' : 'ml'); } catch {}
}

// --- defaults ----------------------------------------------------------------
// Note the canonical Canadian standard drink (341 ml @ 5% ≈ 17.05 ml ethanol)
// sits at the top and is the default benchmark.
export const defaultPresets = () => [
  { id: 'pstd', name: 'Standard drink', volumeMl: 341, abv: 5.0,  kcalPer100ml: null },
  { id: 'p1',   name: 'Regular can',    volumeMl: 355, abv: 5.0,  kcalPer100ml: null },
  { id: 'p2',   name: 'Tall can',       volumeMl: 473, abv: 5.0,  kcalPer100ml: null },
  { id: 'p3',   name: 'Bottle',         volumeMl: 341, abv: 5.0,  kcalPer100ml: null },
  { id: 'p4',   name: 'Pint',           volumeMl: 568, abv: 5.0,  kcalPer100ml: null },
  { id: 'p5',   name: 'Wine glass',     volumeMl: 142, abv: 12.0, kcalPer100ml: null },
  { id: 'p6',   name: 'Shot',           volumeMl: 44,  abv: 40.0, kcalPer100ml: null },
  { id: 'p7',   name: 'Schooner',       volumeMl: 946, abv: 5.0,  kcalPer100ml: null },
];

export const defaultState = () => ({
  people: [
    { name: 'You',    drinks: [] },
    { name: 'Friend', drinks: [] },
  ],
  presets: defaultPresets(),
  benchmarkPresetId: 'pstd',
});

// --- load / migrate ---------------------------------------------------------
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.people) || parsed.people.length < 1) return defaultState();
    if (!Array.isArray(parsed.presets) || parsed.presets.length === 0) parsed.presets = defaultPresets();

    // Ensure the standard drink preset exists; promote it to benchmark if the
    // user was on the previous default (tall can).
    const hadStd = parsed.presets.some(p => p.id === 'pstd');
    if (!hadStd) {
      parsed.presets.unshift({ id: 'pstd', name: 'Standard drink', volumeMl: 341, abv: 5.0, kcalPer100ml: null });
      if (parsed.benchmarkPresetId === 'p2') parsed.benchmarkPresetId = 'pstd';
    }

    // Ensure every preset has the kcalPer100ml field (added in this version).
    parsed.presets.forEach(p => { if (!('kcalPer100ml' in p)) p.kcalPer100ml = null; });

    // Fall back benchmark if it points at something removed.
    if (!parsed.presets.some(p => p.id === parsed.benchmarkPresetId)) {
      parsed.benchmarkPresetId = 'pstd';
    }

    return parsed;
  } catch {
    return defaultState();
  }
}

// --- state singleton -------------------------------------------------------
export const state = loadState();

export function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Save failed', e); }
}

export function getBenchmark() {
  return state.presets.find(p => p.id === state.benchmarkPresetId) || state.presets[0];
}

// --- UPC cache -------------------------------------------------------------
// Maps a UPC string to the preset id that represents it, so rescanning the
// same can is instantaneous even when the BC Liquor catalogue has no record
// (e.g. an out-of-province import the user filled in by hand).
function loadUpcCache() {
  try { return JSON.parse(localStorage.getItem(UPC_CACHE_KEY)) || {}; }
  catch { return {}; }
}

const upcCache = loadUpcCache();

export function getPresetIdForUpc(upc) {
  return upcCache[upc] || null;
}

export function rememberUpc(upc, presetId) {
  if (!upc || !presetId) return false;
  const clean = String(upc).trim();
  if (!clean) return false;
  upcCache[clean] = presetId;
  try { localStorage.setItem(UPC_CACHE_KEY, JSON.stringify(upcCache)); }
  catch (e) { console.warn('UPC cache save failed', e); }
  return true;
}

// Returns every UPC currently mapped to the given preset id.
export function getUpcsForPreset(presetId) {
  return Object.entries(upcCache)
    .filter(([, id]) => id === presetId)
    .map(([upc]) => upc);
}

// Detach a single UPC from whatever preset it points at. Returns true if it
// was actually present.
export function forgetUpc(upc) {
  const clean = String(upc || '').trim();
  if (!clean || !(clean in upcCache)) return false;
  delete upcCache[clean];
  try { localStorage.setItem(UPC_CACHE_KEY, JSON.stringify(upcCache)); }
  catch (e) { console.warn('UPC cache save failed', e); }
  return true;
}

// --- preset mutation helpers ----------------------------------------------
export function addPreset({ name, volumeMl, abv, kcalPer100ml = null, upc = null }) {
  const preset = { id: 'u' + Date.now(), name, volumeMl, abv, kcalPer100ml };
  state.presets.push(preset);
  if (upc) rememberUpc(upc, preset.id);
  saveState();
  return preset;
}

export function removePreset(id) {
  if (state.presets.length <= 1) return false;
  state.presets = state.presets.filter(p => p.id !== id);
  if (state.benchmarkPresetId === id) state.benchmarkPresetId = state.presets[0].id;
  // UPC cache entries pointing at a removed preset will just miss next time;
  // cheap to let them linger rather than scan every cache entry on delete.
  saveState();
  return true;
}

export function setBenchmark(id) {
  if (state.presets.some(p => p.id === id)) {
    state.benchmarkPresetId = id;
    saveState();
  }
}

export function addDrink(personIdx, drink) {
  state.people[personIdx].drinks.push({
    name: drink.name || `${Math.round(drink.volumeMl)} ml · ${drink.abv}%`,
    volumeMl: +drink.volumeMl,
    abv: +drink.abv,
    presetId: drink.presetId || null,
    t: Date.now(),
  });
  saveState();
}

export function removeDrink(personIdx, drinkIdx) {
  state.people[personIdx].drinks.splice(drinkIdx, 1);
  saveState();
}

export function updateDrink(personIdx, drinkIdx, { name, volumeMl, abv }) {
  const d = state.people[personIdx]?.drinks[drinkIdx];
  if (!d) return;
  d.name = name || `${Math.round(volumeMl)} ml · ${abv}%`;
  d.volumeMl = +volumeMl;
  d.abv = +abv;
  d.presetId = null;
  saveState();
}

export function updatePresetAndDrinks(presetId, { name, volumeMl, abv }) {
  const preset = state.presets.find(p => p.id === presetId);
  if (!preset) return;
  if (name) preset.name = name;
  preset.volumeMl = +volumeMl;
  preset.abv = +abv;
  state.people.forEach(person => {
    person.drinks.forEach(d => {
      if (d.presetId !== presetId) return;
      d.name = preset.name;
      d.volumeMl = +volumeMl;
      d.abv = +abv;
    });
  });
  saveState();
}

export function setPersonName(personIdx, name) {
  const fallback = personIdx === 0 ? 'You' : `Friend ${personIdx}`;
  state.people[personIdx].name = name.trim() || fallback;
  saveState();
}

export function addPerson(name) {
  const trimmed = (name == null ? '' : String(name)).trim();
  const idx = state.people.length;
  const fallback = idx === 0 ? 'You' : `Friend ${idx}`;
  state.people.push({ name: trimmed || fallback, drinks: [] });
  saveState();
  return idx;
}

export function removePerson(personIdx) {
  if (state.people.length <= 1) return false;
  if (personIdx < 0 || personIdx >= state.people.length) return false;
  state.people.splice(personIdx, 1);
  saveState();
  return true;
}

export function clearAllDrinks() {
  state.people.forEach(p => p.drinks = []);
  saveState();
}
