// Crowdsourced product submissions. Fires drink data at the central log on
// every drink addition. UPC submissions are deduplicated per session (they
// feed the product catalogue). Non-UPC events are not deduplicated — every
// drink addition is distinct data.
//
// Fail-quiet: if the backend is unconfigured, unreachable, or returns an
// error, we just console.warn — never block the user's flow.

import { API_BASE } from './api.js?v=41';
const SUBMIT_URL = API_BASE + '/submit';

// Dedup set for UPC-tagged submissions only — avoids re-submitting the same
// product when the same can is rescanned or the cached path fires again.
const submittedThisSession = new Set();

export function submitProduct({ upc, name, abv, volumeMl, flavour, from, people }) {
  if (!SUBMIT_URL) return;
  const cleanUpc  = String(upc  || '').replace(/\s+/g, '');
  const cleanName = String(name || '').trim();
  const numAbv    = Number(abv);
  const numVol    = Number(volumeMl);
  if (!cleanName || !Number.isFinite(numAbv)) return;

  // Only dedup UPC submissions — they're for catalogue crowdsourcing and the
  // same product shouldn't appear multiple times. Non-UPC drink-log events
  // are intentionally un-deduplicated: three tall cans in one session = three entries.
  if (cleanUpc) {
    const dedupeKey = `${cleanUpc}|${numAbv}|${Number.isFinite(numVol) ? numVol : ''}`;
    if (submittedThisSession.has(dedupeKey)) return;
    submittedThisSession.add(dedupeKey);
  }

  const body = { name: cleanName, abv: numAbv };
  if (cleanUpc) body.upc = cleanUpc;
  if (Number.isFinite(numVol) && numVol > 0) body.volumeMl = numVol;
  const cleanFlavour = typeof flavour === 'string' ? flavour.trim() : '';
  if (cleanFlavour) body.flavour = cleanFlavour.slice(0, 60);
  if (from) body.from = String(from).trim().slice(0, 40);
  if (Array.isArray(people) && people.length) {
    body.people = people.map(p => String(p).trim().slice(0, 40)).filter(Boolean);
  }

  const payload = JSON.stringify(body);
  // `keepalive` lets the request survive a page-hide on mobile.
  try {
    fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(err => console.warn('Submit failed', err));
  } catch (err) {
    console.warn('Submit threw', err);
  }
}
