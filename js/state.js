// State + sessions client.
//
// Architecture in two sentences: the app always operates on a server-side
// session identified by ?s=<sid>. The in-memory `state` mirror is hydrated
// from the server on load and on each poll, and every mutation is
// optimistic-then-server (sync local update, async API call, revert on error).
//
// localStorage is reduced to:
//   beerConverter.recentSessions  — [{ sid, name, lastSeen }] for the picker
//   beerConverter.unit            — 'ml' | 'oz' display preference
//   beerConverter.theme           — handled by app.js, not here

import { api, ApiError } from './api.js?v=54';

const RECENT_KEY = 'beerConverter.recentSessions';
const UNIT_KEY   = 'beerConverter.unit';
const DEVICE_KEY = 'beerConverter.deviceId';

// ---- device id (for anonymous reactions) -------------------------------

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch { return 'anonymous'; }
}

// ---- unit preference ----------------------------------------------------

export function getUnitPref() {
  try { return localStorage.getItem(UNIT_KEY) === 'oz' ? 'oz' : 'ml'; } catch { return 'ml'; }
}
export function setUnitPref(u) {
  try { localStorage.setItem(UNIT_KEY, u === 'oz' ? 'oz' : 'ml'); } catch {}
}

// ---- defaults (used when seeding a brand-new server session) ------------

export const defaultPresets = () => [
  { presetKey: 'pstd', name: 'Standard drink', volumeMl: 341, abv: 5.0 },
  { presetKey: 'p1',   name: 'Regular can',    volumeMl: 355, abv: 5.0 },
  { presetKey: 'p2',   name: 'Tall can',       volumeMl: 473, abv: 5.0 },
  { presetKey: 'p3',   name: 'Bottle',         volumeMl: 341, abv: 5.0 },
  { presetKey: 'p4',   name: 'Pint',           volumeMl: 568, abv: 5.0 },
  { presetKey: 'p5',   name: 'Wine glass',     volumeMl: 142, abv: 12.0 },
  { presetKey: 'p6',   name: 'Shot',           volumeMl: 44,  abv: 40.0 },
  { presetKey: 'p7',   name: 'Schooner',       volumeMl: 946, abv: 5.0 },
];

const DEFAULT_PEOPLE = () => [{ name: 'You' }, { name: 'Friend' }];

// ---- recent sessions list ----------------------------------------------

export function getRecentSessions() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(s => s && s.sid) : [];
  } catch { return []; }
}

export function rememberSession(sid, name, extras = {}) {
  if (!sid) return;
  const list = getRecentSessions();
  const existing = list.find(s => s.sid === sid) || {};
  const merged = {
    ...existing,
    sid,
    name: name || existing.name || sid,
    lastSeen: Date.now(),
    ...extras,
  };
  const next = list.filter(s => s.sid !== sid);
  next.unshift(merged);
  while (next.length > 20) next.pop();
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
}

export function forgetSessionLocal(sid) {
  const list = getRecentSessions().filter(s => s.sid !== sid);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

// ---- in-memory state mirror --------------------------------------------
//
// Shape kept compatible with the UI's existing reads:
//   state.sid, state.name, state.updatedAt
//   state.benchmarkPresetId    (mirrors server's benchmarkPresetKey)
//   state.presets[i] = { id, name, volumeMl, abv, kcalPer100ml, lastUsedAt }
//   state.people[i]  = { id, name, drinks: [
//       { id, name, flavour?, volumeMl, abv, presetId, t }
//     ]
//   }
// `id` on people/drinks is the numeric server id. `id` on presets is the
// stable preset_key string. The frontend never touches the auto-increment
// id on the session_presets row.

export const state = {
  sid: null,
  publicId: null,
  name: '',
  updatedAt: null,
  benchmarkPresetId: null,
  presets: [],
  people: [],
  events: [],
  comments: [],
  reactions: [],
};

let inFlight = 0;
let pollTimer = null;
let pollMs = 5000;
let lastFetchedAt = 0;

function hydrate(serverPayload) {
  const s = serverPayload || {};
  state.sid = s.id || null;
  state.publicId = s.publicId || null;
  state.name = s.name || '';
  state.updatedAt = s.updatedAt || null;
  state.benchmarkPresetId = s.benchmarkPresetKey || null;
  state.presets = (s.presets || []).map(p => ({
    id:           p.presetKey,
    name:         p.name,
    volumeMl:     p.volumeMl,
    abv:          p.abv,
    kcalPer100ml: p.kcalPer100ml,
    lastUsedAt:   p.lastUsedAt,
    inputKind:    p.inputKind || 'whole',
    components:   Array.isArray(p.components) ? p.components : [],
  }));
  // Sort presets by their original creation order (insertion order is preserved
  // by SQLite default; presetKey 'pstd', 'p1'..'p7', 'u<ts>' sorts naturally
  // for the seeded ones, but recency is what the chip tray actually uses).
  const drinksByPerson = new Map();
  for (const d of (s.drinks || [])) {
    if (!drinksByPerson.has(d.personId)) drinksByPerson.set(d.personId, []);
    drinksByPerson.get(d.personId).push({
      id:        d.id,
      name:      d.name,
      flavour:   d.flavour || undefined,
      volumeMl:  d.volumeMl,
      abv:       d.abv,
      presetId:  d.presetKey || null,
      inputKind: d.inputKind || 'whole',
      components: Array.isArray(d.components) ? d.components : [],
      t:         d.t,
    });
  }
  state.people = (s.people || []).map(p => ({
    id:     p.id,
    name:   p.name,
    drinks: drinksByPerson.get(p.id) || [],
  }));
  state.events = (s.events || []).map(e => ({
    id:        e.id,
    type:      e.type,
    personId:  e.personId || null,
    drinkId:   e.drinkId || null,
    data:      e.data || {},
    t:         e.t,
  }));
  state.comments = (s.comments || []).map(c => ({
    id:         c.id,
    personId:   c.personId || null,
    authorName: c.authorName || null,
    text:       c.text,
    t:          c.t,
  }));
  state.reactions = (s.reactions || []).map(r => ({
    commentId: r.commentId,
    emoji:     r.emoji,
    personId:  r.personId || null,
    deviceId:  r.deviceId || null,
    authorName: r.authorName || null,
  }));
  // Snapshot people + drink count into the recents list so the session
  // switcher can show context without re-fetching every session.
  rememberSession(state.sid, state.name, {
    publicId: state.publicId,
    peopleNames: state.people.map(p => p.name),
    drinkCount:  state.people.reduce((n, p) => n + p.drinks.length, 0),
  });
}


function optimisticDrinkEvent(type, person, drink) {
  state.events.push({
    id: -Date.now() - Math.floor(Math.random() * 1000),
    type,
    personId: person?.id || null,
    drinkId: drink?.id || null,
    data: {
      personName: person?.name || '',
      drinkName: drink?.name || '',
      flavour: drink?.flavour || null,
      volumeMl: drink?.volumeMl,
      abv: drink?.abv,
      inputKind: drink?.inputKind || 'whole',
      components: Array.isArray(drink?.components) ? drink.components : [],
    },
    t: Date.now(),
  });
}

// ---- session lifecycle -------------------------------------------------

export async function loadSession(sid) {
  const data = await api.get(`/api/sessions/${encodeURIComponent(sid)}`);
  hydrate(data);
  lastFetchedAt = Date.now();
  return state;
}

export async function fetchSessionSnapshot(sid) {
  if (!sid) return null;
  return api.get(`/api/sessions/${encodeURIComponent(sid)}`);
}

export async function createSession({
  name,
  importPresetsFromSid,
  people,
  presets,
  benchmarkPresetKey,
} = {}) {
  let seedPeople = Array.isArray(people) && people.length ? people : DEFAULT_PEOPLE();
  let seedPresets = Array.isArray(presets) && presets.length ? dedupePresetSeeds(presets) : defaultPresets();
  if (importPresetsFromSid) {
    try {
      const src = await api.get(`/api/sessions/${encodeURIComponent(importPresetsFromSid)}`);
      if (src && Array.isArray(src.presets) && src.presets.length) {
        seedPresets = dedupePresetSeeds(src.presets.map(p => ({
          presetKey:    p.presetKey,
          name:         p.name,
          volumeMl:     p.volumeMl,
          abv:          p.abv,
          kcalPer100ml: p.kcalPer100ml,
          inputKind:    p.inputKind || 'whole',
          components:   Array.isArray(p.components) ? p.components.map(c => ({ ...c })) : [],
        })));
      }
    } catch (e) { console.warn('preset import failed; using defaults', e); }
  }
  const data = await api.post('/api/sessions', {
    name: name || undefined,
    people: seedPeople,
    presets: seedPresets,
    benchmarkPresetKey: benchmarkPresetKey || 'pstd',
  });
  rememberSession(data.id, data.name, { publicId: data.publicId || null });
  return data.id;
}

function dedupePresetSeeds(presets) {
  const seen = new Set();
  return presets.filter(p => {
    const sig = presetSignature(p) || p.presetKey;
    if (!sig || seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

// "Switch to this session" = navigate. Full page load for simplicity, so the
// boot flow re-runs and any in-flight state is dropped cleanly.
export function switchSession(sid) {
  if (!sid) return;
  location.search = '?s=' + encodeURIComponent(sid);
}

export async function renameSession(sid, name) {
  if (!sid || sid !== state.sid) {
    // Renaming another session you've been to: only update the local list.
    const list = getRecentSessions();
    const e = list.find(s => s.sid === sid);
    if (!e) return false;
    e.name = name;
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
    return true;
  }
  const trimmed = String(name == null ? '' : name).trim().slice(0, 60);
  if (!trimmed) return false;
  const prev = state.name;
  state.name = trimmed;
  rememberSession(sid, trimmed);
  inFlight++;
  try { await api.patch(`/api/sessions/${encodeURIComponent(sid)}`, { name: trimmed }); }
  catch (e) { state.name = prev; console.error('rename failed', e); alert('Rename failed'); }
  finally { inFlight--; }
  return true;
}

export async function deleteSession(sid) {
  if (!sid) return false;
  forgetSessionLocal(sid);
  try { await api.del(`/api/sessions/${encodeURIComponent(sid)}`); }
  catch (e) { console.error('delete failed', e); /* still gone from local list */ }
  return true;
}

// ---- polling -----------------------------------------------------------

export function startPolling(onChange) {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (inFlight > 0) return;
    if (!state.sid) return;
    try {
      const data = await api.get(`/api/sessions/${encodeURIComponent(state.sid)}`);
      if (!data) return;
      if (data.updatedAt && data.updatedAt === state.updatedAt) return;
      hydrate(data);
      lastFetchedAt = Date.now();
      onChange?.();
    } catch (e) { /* network blip — quiet, try again next tick */ }
  }, pollMs);
}

export function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Manual one-shot refresh (e.g. after error). Resolves with the latest state.
export async function refreshSession() {
  if (!state.sid) return null;
  const data = await api.get(`/api/sessions/${encodeURIComponent(state.sid)}`);
  hydrate(data);
  return state;
}

// ---- benchmark ----------------------------------------------------------

export function getBenchmark() {
  return state.presets.find(p => p.id === state.benchmarkPresetId) || state.presets[0];
}

export async function setBenchmark(presetId) {
  if (!state.sid) return;
  if (!state.presets.some(p => p.id === presetId)) return;
  const prev = state.benchmarkPresetId;
  state.benchmarkPresetId = presetId;
  inFlight++;
  try { await api.patch(`/api/sessions/${encodeURIComponent(state.sid)}`, { benchmarkPresetKey: presetId }); }
  catch (e) { state.benchmarkPresetId = prev; console.error('benchmark set failed', e); }
  finally { inFlight--; }
}

// ---- presets ------------------------------------------------------------

function componentSignature(components) {
  if (!Array.isArray(components) || !components.length) return '';
  // Order matters: two cocktails with the same bottles in different ratios are
  // different presets, so we don't sort. Name+vol+abv per row is enough.
  return components.map(c => {
    const name = String(c?.name || '').trim().toLowerCase();
    const vol = Number(c?.volumeMl);
    const abv = Number(c?.abv);
    return `${name}@${Number.isFinite(vol) ? vol.toFixed(2) : '?'}/${Number.isFinite(abv) ? abv.toFixed(2) : '?'}`;
  }).join('+');
}

export function presetSignature({ name, volumeMl, abv, inputKind, components } = {}) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const vol = Number(volumeMl);
  const alc = Number(abv);
  if (!cleanName || !Number.isFinite(vol) || !Number.isFinite(alc)) return '';
  const base = `${cleanName}|${vol.toFixed(2)}|${alc.toFixed(2)}`;
  // Cocktail presets fold the component list in so two cocktails that happen
  // to share name/volume/ABV (e.g. two takes on a 75 ml 35% Martini) don't
  // collapse into one preset.
  if (inputKind === 'cocktail') {
    return `cocktail:${base}|${componentSignature(components)}`;
  }
  return base;
}

export function findMatchingPreset({ name, volumeMl, abv, inputKind, components } = {}) {
  const sig = presetSignature({ name, volumeMl, abv, inputKind, components });
  if (!sig) return null;
  return state.presets.find(p => presetSignature(p) === sig) || null;
}

// Returns synchronously so call sites can immediately reference the new
// preset's id. The server save runs in the background; failure rolls the
// optimistic add back and alerts.
export function addPreset({ name, volumeMl, abv, kcalPer100ml = null, inputKind = 'whole', components = null } = {}) {
  if (!state.sid) return null;
  const isCocktail = inputKind === 'cocktail' && Array.isArray(components) && components.length > 0;
  const componentsCopy = isCocktail ? components.map(c => ({ ...c })) : [];
  const existing = findMatchingPreset({ name, volumeMl, abv, inputKind: isCocktail ? 'cocktail' : 'whole', components: componentsCopy });
  if (existing) {
    existing.lastUsedAt = Date.now();
    touchPreset(existing.id).catch(() => {});
    return existing;
  }
  const presetKey = 'u' + Date.now();
  const local = {
    id: presetKey,
    name,
    volumeMl,
    abv,
    kcalPer100ml,
    lastUsedAt: Date.now(),
    inputKind: isCocktail ? 'cocktail' : 'whole',
    components: componentsCopy,
  };
  state.presets.push(local);
  inFlight++;
  api.post(`/api/sessions/${encodeURIComponent(state.sid)}/presets`, {
    presetKey, name, volumeMl, abv, kcalPer100ml, lastUsedAt: local.lastUsedAt,
    inputKind: local.inputKind,
    components: local.components,
  }).catch(e => {
    console.error('addPreset failed', e); alert('Save type failed');
    state.presets = state.presets.filter(p => p !== local);
  }).finally(() => { inFlight--; });
  return local;
}

export async function removePreset(id) {
  if (!state.sid) return false;
  if (state.presets.length <= 1) return false;
  const idx = state.presets.findIndex(p => p.id === id);
  if (idx < 0) return false;
  const removed = state.presets.splice(idx, 1)[0];
  // If we removed the benchmark, snap to the first remaining.
  let prevBench = state.benchmarkPresetId;
  if (state.benchmarkPresetId === id) {
    state.benchmarkPresetId = state.presets[0]?.id || null;
  }
  inFlight++;
  try {
    await api.del(`/api/sessions/${encodeURIComponent(state.sid)}/presets/${encodeURIComponent(id)}`);
    if (state.benchmarkPresetId !== prevBench) {
      // Best-effort: tell the server the benchmark moved too.
      try { await api.patch(`/api/sessions/${encodeURIComponent(state.sid)}`, { benchmarkPresetKey: state.benchmarkPresetId }); } catch {}
    }
    return true;
  } catch (e) {
    console.error('removePreset failed', e); alert('Delete failed');
    state.presets.splice(idx, 0, removed);
    state.benchmarkPresetId = prevBench;
    return false;
  } finally { inFlight--; }
}

// "Edit type and all its drinks" — server cascades the volume/abv/name
// (and components, for cocktail presets) onto every drink linked to this
// preset in one transaction.
export async function updatePresetAndDrinks(id, { name, volumeMl, abv, inputKind, components }) {
  if (!state.sid) return;
  const preset = state.presets.find(p => p.id === id);
  if (!preset) return;
  const prev = {
    name: preset.name,
    volumeMl: preset.volumeMl,
    abv: preset.abv,
    inputKind: preset.inputKind,
    components: Array.isArray(preset.components) ? preset.components.map(c => ({ ...c })) : [],
  };
  if (name) preset.name = name;
  preset.volumeMl = +volumeMl;
  preset.abv = +abv;
  const nextKind = inputKind === 'cocktail' ? 'cocktail' : 'whole';
  preset.inputKind = nextKind;
  preset.components = nextKind === 'cocktail' && Array.isArray(components)
    ? components.map(c => ({ ...c }))
    : [];
  // Apply to local drinks too so the UI updates instantly.
  state.people.forEach(person => person.drinks.forEach(d => {
    if (d.presetId !== id) return;
    d.name = preset.name;
    d.volumeMl = preset.volumeMl;
    d.abv = preset.abv;
    d.inputKind = preset.inputKind;
    d.components = preset.components.map(c => ({ ...c }));
  }));
  inFlight++;
  try {
    await api.patch(
      `/api/sessions/${encodeURIComponent(state.sid)}/presets/${encodeURIComponent(id)}`,
      {
        name: preset.name,
        volumeMl: preset.volumeMl,
        abv: preset.abv,
        inputKind: preset.inputKind,
        components: preset.components,
      }
    );
  } catch (e) {
    console.error('updatePresetAndDrinks failed', e); alert('Save failed; refreshing.');
    Object.assign(preset, prev);
    refreshSession().catch(() => {});
  } finally { inFlight--; }
}

export async function touchPreset(presetId) {
  if (!state.sid || !presetId) return;
  const p = state.presets.find(x => x.id === presetId);
  if (!p) return;
  p.lastUsedAt = Date.now();
  inFlight++;
  try { await api.post(`/api/sessions/${encodeURIComponent(state.sid)}/presets/${encodeURIComponent(presetId)}/touch`); }
  catch (e) { /* recency hint; non-critical */ }
  finally { inFlight--; }
}

// ---- people ------------------------------------------------------------

export async function setPersonName(personIdx, name) {
  if (!state.sid) return;
  const p = state.people[personIdx];
  if (!p) return;
  const fallback = personIdx === 0 ? 'You' : `Friend ${personIdx}`;
  const next = (name || '').trim() || fallback;
  const prev = p.name;
  p.name = next;
  inFlight++;
  try { await api.patch(`/api/sessions/${encodeURIComponent(state.sid)}/people/${p.id}`, { name: next }); }
  catch (e) { p.name = prev; console.error('rename person failed', e); }
  finally { inFlight--; }
}

export async function addPerson(name) {
  if (!state.sid) return -1;
  const trimmed = (name || '').toString().trim();
  // Optimistic insert with a placeholder id; replaced on response.
  const placeholder = { id: -Date.now(), name: trimmed || `Friend ${state.people.length}`, drinks: [] };
  state.people.push(placeholder);
  const idx = state.people.length - 1;
  inFlight++;
  try {
    const saved = await api.post(`/api/sessions/${encodeURIComponent(state.sid)}/people`, { name: trimmed });
    placeholder.id = saved.id;
    placeholder.name = saved.name;
    return idx;
  } catch (e) {
    console.error('addPerson failed', e); alert('Add person failed');
    state.people.splice(idx, 1);
    return -1;
  } finally { inFlight--; }
}

export async function removePerson(personIdx) {
  if (!state.sid) return false;
  if (state.people.length <= 1) return false;
  const removed = state.people.splice(personIdx, 1)[0];
  if (!removed) return false;
  inFlight++;
  try {
    await api.del(`/api/sessions/${encodeURIComponent(state.sid)}/people/${removed.id}`);
    return true;
  } catch (e) {
    console.error('removePerson failed', e); alert('Remove person failed');
    state.people.splice(personIdx, 0, removed);
    return false;
  } finally { inFlight--; }
}

// ---- drinks ------------------------------------------------------------

export async function addDrink(personIdx, drink) {
  if (!state.sid) return;
  const person = state.people[personIdx];
  if (!person) return;
  const flavour = typeof drink.flavour === 'string' ? drink.flavour.trim() : '';
  const optimistic = {
    id:        -Date.now(),
    name:      drink.name || `${Math.round(drink.volumeMl)} ml · ${drink.abv}%`,
    volumeMl:  +drink.volumeMl,
    abv:       +drink.abv,
    presetId:  drink.presetId || null,
    inputKind: drink.inputKind === 'cocktail' ? 'cocktail' : 'whole',
    components: Array.isArray(drink.components) ? drink.components.map(c => ({ ...c })) : [],
    t:         Date.now(),
  };
  if (flavour) optimistic.flavour = flavour;
  person.drinks.push(optimistic);
  optimisticDrinkEvent('drink_added', person, optimistic);
  if (optimistic.presetId) {
    const p = state.presets.find(x => x.id === optimistic.presetId);
    if (p) p.lastUsedAt = Date.now();
  }
  inFlight++;
  try {
    const saved = await api.post(`/api/sessions/${encodeURIComponent(state.sid)}/drinks`, {
      personId:  person.id,
      presetKey: optimistic.presetId,
      name:      optimistic.name,
      flavour:   flavour || undefined,
      volumeMl:  optimistic.volumeMl,
      abv:       optimistic.abv,
      inputKind: optimistic.inputKind,
      components: optimistic.components,
      t:         optimistic.t,
    });
    if (saved) {
      optimistic.id = saved.id;
      optimistic.t  = saved.t;
      optimistic.volumeMl = saved.volumeMl;
      optimistic.abv = saved.abv;
      optimistic.inputKind = saved.inputKind || optimistic.inputKind;
      optimistic.components = Array.isArray(saved.components) ? saved.components : optimistic.components;
    }
  } catch (e) {
    console.error('addDrink failed', e); alert('Add drink failed');
    person.drinks = person.drinks.filter(d => d !== optimistic);
    state.events = state.events.filter(e => !(e.drinkId === optimistic.id && e.type === 'drink_added'));
  } finally { inFlight--; }
}

export async function removeDrink(personIdx, drinkIdx) {
  if (!state.sid) return;
  const person = state.people[personIdx];
  if (!person) return;
  const removed = person.drinks.splice(drinkIdx, 1)[0];
  if (!removed) return;
  optimisticDrinkEvent('drink_removed', person, removed);
  inFlight++;
  try {
    await api.del(`/api/sessions/${encodeURIComponent(state.sid)}/drinks/${removed.id}`);
  } catch (e) {
    console.error('removeDrink failed', e); alert('Remove drink failed');
    state.events = state.events.filter(ev => !(ev.drinkId === removed.id && ev.type === 'drink_removed'));
    person.drinks.splice(drinkIdx, 0, removed);
  } finally { inFlight--; }
}

// Per-drink flavour update (no n/v/a change). Doesn't unlink from preset.
export async function setDrinkFlavour(personIdx, drinkIdx, flavour) {
  if (!state.sid) return;
  const person = state.people[personIdx];
  const d = person?.drinks[drinkIdx];
  if (!d) return;
  const prev = d.flavour;
  const trimmed = typeof flavour === 'string' ? flavour.trim() : '';
  if (trimmed) d.flavour = trimmed; else delete d.flavour;
  inFlight++;
  try {
    await api.patch(
      `/api/sessions/${encodeURIComponent(state.sid)}/drinks/${d.id}`,
      { flavour: trimmed }
    );
  } catch (e) {
    console.error('setDrinkFlavour failed', e); alert('Save flavour failed');
    if (prev) d.flavour = prev; else delete d.flavour;
  } finally { inFlight--; }
}

// Edit a single drink's name/volume/abv (and optionally flavour). Unlinks
// from its preset, matching the existing UI semantics where "edit just this
// one" diverges from the saved type.
export async function updateDrink(personIdx, drinkIdx, { name, volumeMl, abv, flavour, inputKind = 'whole', components = [] }) {
  if (!state.sid) return;
  const person = state.people[personIdx];
  const d = person?.drinks[drinkIdx];
  if (!d) return;
  const prev = { ...d };
  d.name = name || `${Math.round(volumeMl)} ml · ${abv}%`;
  d.volumeMl = +volumeMl;
  d.abv = +abv;
  d.presetId = null;
  d.inputKind = inputKind === 'cocktail' ? 'cocktail' : 'whole';
  d.components = Array.isArray(components) ? components.map(c => ({ ...c })) : [];
  if (flavour !== undefined) {
    const trimmed = typeof flavour === 'string' ? flavour.trim() : '';
    if (trimmed) d.flavour = trimmed; else delete d.flavour;
  }
  inFlight++;
  try {
    await api.patch(
      `/api/sessions/${encodeURIComponent(state.sid)}/drinks/${d.id}`,
      {
        name: d.name, volumeMl: d.volumeMl, abv: d.abv,
        flavour: d.flavour || '',
        inputKind: d.inputKind,
        components: d.components,
        unlinkPreset: true,
      }
    );
  } catch (e) {
    console.error('updateDrink failed', e); alert('Save failed');
    Object.assign(d, prev);
  } finally { inFlight--; }
}

// ---- comments -----------------------------------------------------------

export async function addComment(text, { personId = null, authorName = null } = {}) {
  if (!state.sid) return;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const optimistic = {
    id:         -Date.now(),
    personId:   personId,
    authorName: authorName,
    text:       trimmed,
    t:          Date.now(),
  };
  state.comments.push(optimistic);
  inFlight++;
  try {
    const saved = await api.post(`/api/sessions/${encodeURIComponent(state.sid)}/comments`, {
      personId,
      authorName,
      text: trimmed,
      t:    optimistic.t,
    });
    if (saved) {
      optimistic.id = saved.id;
    }
  } catch (e) {
    console.error('addComment failed', e); alert('Add comment failed');
    state.comments = state.comments.filter(c => c !== optimistic);
  } finally { inFlight--; }
}

export async function removeComment(commentId) {
  if (!state.sid) return;
  const idx = state.comments.findIndex(c => c.id === commentId);
  if (idx < 0) return;
  const removed = state.comments.splice(idx, 1)[0];
  inFlight++;
  try {
    await api.del(`/api/sessions/${encodeURIComponent(state.sid)}/comments/${commentId}`);
  } catch (e) {
    console.error('removeComment failed', e); alert('Remove comment failed');
    state.comments.splice(idx, 0, removed);
  } finally { inFlight--; }
}

export async function updateComment(commentId, text) {
  if (!state.sid) return;
  const c = state.comments.find(x => x.id === commentId);
  if (!c) return;
  const prev = c.text;
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  c.text = trimmed;
  inFlight++;
  try {
    await api.patch(
      `/api/sessions/${encodeURIComponent(state.sid)}/comments/${commentId}`,
      { text: trimmed }
    );
  } catch (e) {
    console.error('updateComment failed', e); alert('Save comment failed');
    c.text = prev;
  } finally { inFlight--; }
}

export async function toggleCommentReaction(commentId, emoji, personId = null, authorName = null) {
  if (!state.sid) return;
  const deviceId = getDeviceId();
  
  // Optimistic update
  const existingIdx = state.reactions.findIndex(r => 
    r.commentId === commentId && 
    r.emoji === emoji && 
    r.personId === personId && 
    (personId ? true : r.deviceId === deviceId)
  );
  
  const prevReactions = [...state.reactions];
  if (existingIdx >= 0) {
    state.reactions.splice(existingIdx, 1);
  } else {
    state.reactions.push({ commentId, emoji, personId, deviceId, authorName });
  }

  inFlight++;
  try {
    await api.post(`/api/sessions/${encodeURIComponent(state.sid)}/comments/${commentId}/react`, {
      emoji,
      personId,
      deviceId,
      authorName,
    });
  } catch (e) {
    console.error('toggleReaction failed', e);
    state.reactions = prevReactions;
  } finally { inFlight--; }
}

export async function clearAllDrinks() {
  if (!state.sid) return;
  // Easiest correct path: remove each drink one-by-one. Could optimize later
  // with a bulk endpoint, but clearing is rare.
  const all = [];
  for (let pi = 0; pi < state.people.length; pi++) {
    const p = state.people[pi];
    for (const d of p.drinks) all.push({ pi, did: d.id });
  }
  state.people.forEach(p => p.drinks = []);
  inFlight++;
  try {
    for (const { did } of all) {
      try { await api.del(`/api/sessions/${encodeURIComponent(state.sid)}/drinks/${did}`); }
      catch (e) { console.warn('drink delete failed', did, e); }
    }
  } finally { inFlight--; }
}

// `newSession` exists for compatibility with the existing button wiring.
// Behaviour: create on the server, navigate to it (full reload).
export async function newSession() {
  const sid = await createSession({});
  switchSession(sid);
  return sid;
}

// ---- shims for behaviours we no longer support --------------------------
// Kept only so existing UI code that imported these doesn't crash. The
// preset-modal UPC manager is being rebuilt in a follow-up phase; for now
// these are quiet no-ops so the rest of the app boots cleanly.
export function getPresetIdForUpc()    { return null; }
export function rememberUpc()          { return false; }
export function getUpcsForPreset()     { return []; }
export function forgetUpc()            { return false; }
