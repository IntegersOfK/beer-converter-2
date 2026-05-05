// Crowdsourced product submissions. Fires { upc, name, abv, volumeMl? } at
// the central log when a user fills in a custom drink that includes a UPC.
//
// Fail-quiet: if the backend is unconfigured, unreachable, or returns an
// error, we just console.warn — never block the user's flow. The local
// drink log + UPC cache work entirely without this endpoint.
//
// To enable: set SUBMIT_URL to your deployment's /submit endpoint.

// Local dev hits the Node server on :8787. Prod uses a same-origin relative
// path — the host is expected to reverse-proxy /submit to the backend.
// Pointing prod at localhost would trigger Chrome's Private Network Access
// prompt ("Apps on device") because a public origin can't reach 127.0.0.1.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SUBMIT_URL = IS_LOCAL ? 'http://localhost:8787/submit' : '/submit';

// Avoid double-submitting the same UPC+ABV+volume combo from the same session.
// Keying on all three allows a corrected re-add (different ABV or volume) to
// go through, while still deduplicating true duplicates.
const submittedThisSession = new Set();

export function submitProduct({ upc, name, abv, volumeMl }) {
  if (!SUBMIT_URL) return;
  const cleanUpc  = String(upc  || '').replace(/\s+/g, '');
  const cleanName = String(name || '').trim();
  const numAbv    = Number(abv);
  const numVol    = Number(volumeMl);
  if (!cleanUpc || !cleanName || !Number.isFinite(numAbv)) return;
  const dedupeKey = `${cleanUpc}|${numAbv}|${Number.isFinite(numVol) ? numVol : ''}`;
  if (submittedThisSession.has(dedupeKey)) return;
  submittedThisSession.add(dedupeKey);

  const body = { upc: cleanUpc, name: cleanName, abv: numAbv };
  if (Number.isFinite(numVol) && numVol > 0) body.volumeMl = numVol;
  const payload = JSON.stringify(body);
  // `keepalive` lets the request survive a page-hide on mobile, since the
  // user often closes the modal/tab right after hitting "Add drink".
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
