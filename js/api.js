// Thin fetch wrapper for the server-side sessions API.
//
// The backend lives on :8787 in dev (run via `node server/index.js`) and
// is reverse-proxied at the same origin in prod. The IS_LOCAL gate keeps
// requests from going to localhost from a non-localhost page (Chrome's
// Private Network Access would prompt the user otherwise).

const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
export const API_BASE = IS_LOCAL ? 'http://localhost:8787' : '';

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status}: ${body}`);
    this.status = status;
  }
}

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(API_BASE + path, init);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(method, path, r.status, text);
  }
  if (r.status === 204) return null;
  // Some DELETE handlers return JSON; some return nothing — handle both.
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export const api = {
  get:    (p)        => request('GET',    p),
  post:   (p, body)  => request('POST',   p, body == null ? {} : body),
  patch:  (p, body)  => request('PATCH',  p, body == null ? {} : body),
  del:    (p)        => request('DELETE', p),
};

export { ApiError };
