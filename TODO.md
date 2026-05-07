# TODO

Backlog of UX nits and feature requests. Not in priority order.

## Server-side shared sessions (in progress)

Multi-phase rollout to move sessions from `localStorage` onto the server,
so anyone with the session URL can contribute to the same tally.

- [x] **Phase 0** — SQLite catalogue: replace `products.json`, `upcs.json`,
  `submissions.jsonl`, `rejected.jsonl` with a single `data.db` via
  `better-sqlite3`. Existing JSON/JSONL files imported on first boot, then
  renamed `*.migrated`. All admin endpoints kept wire-compatible.
- [ ] **Phase 1** — Sessions schema + endpoints. Tables: `sessions`,
  `session_people`, `session_drinks`, `session_presets`. Session id is a
  ~22-char URL-safe random (`crypto.randomBytes(16)` → base64url). REST API
  under `/api/sessions/...`. Permissions = obfuscation only; anyone with
  the link can do anything.
- [ ] **Phase 2** — Frontend session-only mode. URL is always
  `?s=<sid>`. On bare URL: redirect to most recent in localStorage, else
  create new and redirect. New-session UI offers preset import from a
  previous session. Polling every 5 s when tab visible.
- [ ] **Phase 3** — Live report. `report.html?s=<sid>` fetches and polls.
  Drop the base64 blob and the "Import to app" button.
- [ ] **Phase 4** — Share UX. "Copy session link" button.

## Default presets vs user-added presets visual inconsistency

User feedback: defaults (Schooner, Shot, etc.) feel different from
user-added presets in the Drink Types modal — defaults appear to "just
let you delete" while user-added ones say "manage". The render code
treats them identically apart from the `+ Barcode` vs `Manage` button
text on the barcode popover (defaults ship with no UPCs, user-adds via
scan come with one). Need to clarify what the user is seeing before
touching it.

(May be obsoleted by Phase 2 — presets become session-scoped on the
server, so this UI gets revisited anyway.)
