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

// Avoid double-submitting the same UPC from the same session — a single
// mistyped ABV otherwise floods the log when the user re-adds the drink.
const submittedThisSession = new Set();

export function submitProduct({ upc, name, abv, volumeMl }) {
  if (!SUBMIT_URL) return;
  const cleanUpc  = String(upc  || '').replace(/\s+/g, '');
  const cleanName = String(name || '').trim();
  const numAbv    = Number(abv);
  if (!cleanUpc || !cleanName || !Number.isFinite(numAbv)) return;
  if (submittedThisSession.has(cleanUpc)) return;
  submittedThisSession.add(cleanUpc);

  const body = { upc: cleanUpc, name: cleanName, abv: numAbv };
  const numVol = Number(volumeMl);
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
