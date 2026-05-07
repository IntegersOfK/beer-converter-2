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

function sessionLabel(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { month: 'long', day: 'numeric' });
}

function makeSession(people, benchmarkPresetId = 'pstd', ts = Date.now()) {
  return { id: 's' + ts, name: sessionLabel(ts), ts, people, benchmarkPresetId };
}

function freshPeople() {
  return [{ name: 'You', drinks: [] }, { name: 'Friend', drinks: [] }];
}

// --- load / migrate ----------------------------------------------------------
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed) return defaultState();

    if (parsed.schemaVersion === 2 && Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
      return loadV2(parsed);
    }

    // Legacy v1: top-level people array
    if (Array.isArray(parsed.people) && parsed.people.length > 0) {
      return migrateV1(parsed);
    }

    return defaultState();
  } catch {
    return defaultState();
  }
}

function ensurePresets(parsed) {
  if (!Array.isArray(parsed.presets) || parsed.presets.length === 0) parsed.presets = defaultPresets();
  if (!parsed.presets.some(p => p.id === 'pstd')) {
    parsed.presets.unshift({ id: 'pstd', name: 'Standard drink', volumeMl: 341, abv: 5.0, kcalPer100ml: null });
  }
  parsed.presets.forEach(p => { if (!('kcalPer100ml' in p)) p.kcalPer100ml = null; });
}

function loadV2(parsed) {
  ensurePresets(parsed);

  // Ensure every session has a valid people array.
  parsed.sessions.forEach(s => {
    if (!Array.isArray(s.people) || s.people.length === 0) s.people = freshPeople();
    if (!s.benchmarkPresetId) s.benchmarkPresetId = 'pstd';
  });

  let active = parsed.sessions.find(s => s.id === parsed.activeSessionId);
  if (!active) {
    active = parsed.sessions[parsed.sessions.length - 1];
    parsed.activeSessionId = active.id;
  }

  if (!parsed.presets.some(p => p.id === active.benchmarkPresetId)) {
    active.benchmarkPresetId = 'pstd';
  }

  // Runtime aliases — not serialized, always mirror active session.
  parsed.people = active.people;
  parsed.benchmarkPresetId = active.benchmarkPresetId;

  return parsed;
}

function migrateV1(parsed) {
  ensurePresets(parsed);
  if (!parsed.presets.some(p => p.id === parsed.benchmarkPresetId)) {
    parsed.benchmarkPresetId = 'pstd';
  }
  // Promote old tall-can benchmark to standard drink.
  if (parsed.benchmarkPresetId === 'p2') parsed.benchmarkPresetId = 'pstd';

  const ts = Date.now();
  const session = makeSession(parsed.people, parsed.benchmarkPresetId || 'pstd', ts);
  parsed.schemaVersion = 2;
  parsed.sessions = [session];
  parsed.activeSessionId = session.id;
  parsed.people = session.people;
  parsed.benchmarkPresetId = session.benchmarkPresetId;
  return parsed;
}

function defaultState() {
  const ts = Date.now();
  const session = makeSession(freshPeople(), 'pstd', ts);
  return {
    schemaVersion: 2,
    presets: defaultPresets(),
    sessions: [session],
    activeSessionId: session.id,
    people: session.people,
    benchmarkPresetId: session.benchmarkPresetId,
  };
}

// --- state singleton -------------------------------------------------------
export const state = loadState();

function activeSession() {
  return state.sessions.find(s => s.id === state.activeSessionId) || state.sessions[0];
}

export function saveState() {
  // Sync primitive fields back before serializing (people is already same reference).
  const sess = activeSession();
  if (sess) {
    sess.people = state.people;
    sess.benchmarkPresetId = state.benchmarkPresetId;
  }
  const toSave = {
    schemaVersion: 2,
    presets: state.presets,
    sessions: state.sessions,
    activeSessionId: state.activeSessionId,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)); }
  catch (e) { console.warn('Save failed', e); }
}

// --- Session management ---------------------------------------------------
export function newSession() {
  const ts = Date.now();
  const sess = makeSession(freshPeople(), 'pstd', ts);
  state.sessions.push(sess);
  state.activeSessionId = sess.id;
  state.people = sess.people;
  state.benchmarkPresetId = sess.benchmarkPresetId;
  saveState();
  return sess.id;
}

export function switchSession(id) {
  const sess = state.sessions.find(s => s.id === id);
  if (!sess || sess.id === state.activeSessionId) return;
  state.activeSessionId = id;
  state.people = sess.people;
  state.benchmarkPresetId = sess.benchmarkPresetId || 'pstd';
  saveState();
}

export function renameSession(id, name) {
  const sess = state.sessions.find(s => s.id === id);
  if (!sess) return false;
  const trimmed = String(name == null ? '' : name).trim().slice(0, 40);
  // Empty name reverts to the auto label so the user can never wipe it blank.
  sess.name = trimmed || sessionLabel(sess.ts);
  saveState();
  return true;
}

export function deleteSession(id) {
  if (state.sessions.length <= 1) return false;
  const idx = state.sessions.findIndex(s => s.id === id);
  if (idx === -1) return false;
  state.sessions.splice(idx, 1);
  if (state.activeSessionId === id) {
    const next = state.sessions[Math.min(idx, state.sessions.length - 1)];
    state.activeSessionId = next.id;
    state.people = next.people;
    state.benchmarkPresetId = next.benchmarkPresetId || 'pstd';
  }
  saveState();
  return true;
}

export function getBenchmark() {
  return state.presets.find(p => p.id === state.benchmarkPresetId) || state.presets[0];
}

// --- UPC cache -------------------------------------------------------------
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

export function getUpcsForPreset(presetId) {
  return Object.entries(upcCache)
    .filter(([, id]) => id === presetId)
    .map(([upc]) => upc);
}

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
  if (state.benchmarkPresetId === id) {
    state.benchmarkPresetId = state.presets[0].id;
    const sess = activeSession();
    if (sess) sess.benchmarkPresetId = state.benchmarkPresetId;
  }
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
