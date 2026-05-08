# Review Notes

## PR #6: broad backend static-file fallback

PR #6 adds a `serveStatic()` fallback to `server/index.js` that serves files
from `REPO_ROOT` for any unmatched `GET` request. That is risky if the Node
backend is reachable directly or if the reverse proxy is later changed to send
more paths to Node.

Why this matters:

- `REPO_ROOT` includes non-public files and directories, not just browser
  assets.
- A broad fallback can make paths like `/server/db.js`, `/server/index.js`, or
  other repo files available over HTTP.
- If `server/data.db` exists in production, serving from the repo root could
  expose application data.
- The PR also updates the README to suggest running the whole app from
  `http://localhost:8787`, which makes this fallback part of the normal serving
  path rather than only a development convenience.

Safer options:

- Keep the current deployment shape: Caddy serves static files, Node serves
  only API/admin/catalog routes.
- If Node must serve the frontend, restrict the allowlist to known public
  assets such as `/`, `/index.html`, `/report.html`, `/styles.css`, `/js/*`,
  and the bundled CSV.
- Do not serve anything under `/server`, `.git`, or other repository metadata.
- Prefer resolving the requested path and verifying it stays inside a dedicated
  public directory instead of using the repository root.

Related note: the new comments API paths are under `/api/sessions/*`, so the
existing reverse-proxy rule for `/api/sessions` and `/api/sessions/*` should
cover them. The pathing concern is the broad static fallback, not the comments
API route shape.
