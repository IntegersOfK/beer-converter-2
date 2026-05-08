# TODO

Backlog of UX nits and feature requests. Not in priority order.

## Server-side shared sessions (in progress)

Multi-phase rollout to move sessions from `localStorage` onto the server,
so anyone with the session URL can contribute to the same tally.

- [x] **Phase 0** — SQLite catalogue: replace `products.json`, `upcs.json`,
  `submissions.jsonl`, `rejected.jsonl` with a single `data.db` via
  `better-sqlite3`. Existing JSON/JSONL files imported on first boot, then
  renamed `*.migrated`. All admin endpoints kept wire-compatible.
- [x] **Phase 1** — Sessions schema + endpoints. Tables: `sessions`,
  `session_people`, `session_drinks`, `session_presets`. Session id is a
  ~22-char URL-safe random (`crypto.randomBytes(16)` → base64url). REST API
  under `/api/sessions/...`. Permissions = obfuscation only; anyone with
  the link can do anything.
- [x] **Phase 2** — Frontend session-only mode. URL is always
  `?s=<sid>`. On bare URL: redirect to most recent in localStorage, else
  create new and redirect. New-session UI offers preset import from a
  previous session. Polling every 5 s when tab visible.
- [x] **Phase 3** — Live report. `report.html?s=<sid>` fetches and polls.
  Drop the base64 blob and the "Import to app" button. (Legacy `?d=`
  blob still rendered for backward compatibility, just doesn't poll.)
- [ ] **Phase 4** — Share UX. "Copy session link" button.

## Session UPC cache

Phase 2 dropped the per-device UPC→preset cache entirely. New scans are
forced through the catalogue (BC Liquor + curated). For UPCs that aren't
in the catalogue, users have to retype the name on every scan.

A session-scoped `session_upc_cache(session_id, upc, preset_key)` table
would restore the "scan once, named for the rest of the session" UX —
shared with everyone in the session, since presets are shared.

## Session comments

- Allow comments to be added to a session, probably by asking for the
  commenter's name.
- Make commenting available only from the final report.

## Admin: session management

- Sessions overview in the admin GUI: list of all sessions with name,
  created date, last activity, contributor count, drink count.
- Click-through that takes the curator into a specific session as a
  contributor (just opens `/?s=<sid>` in a new tab — no special auth path
  needed since admin already knows the obfuscated id).
- Optional: rename / delete a session from the admin overview.

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
