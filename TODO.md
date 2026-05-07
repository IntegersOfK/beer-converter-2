# TODO

Backlog of UX nits and feature requests. Not in priority order.

## Move backend storage to SQLite

Today the server keeps `products.json`, `upcs.json`, `submissions.jsonl`,
and `rejected.jsonl` as plain files. As submissions grow this gets harder
to query and harder to keep consistent under concurrent writes.

Open questions to settle before starting:

- Driver: `better-sqlite3` (mature, sync, requires `package.json` +
  `npm install` — breaks the current zero-deps stance) versus the built-in
  `node:sqlite` (no deps, requires Node 22.5+).
- Migration: one-shot read of the existing JSON/JSONL files on first boot,
  archive originals next to `curated.legacy.json`.
- Schema sketch: `products`, `upcs`, `submissions`, `rejected_upcs` —
  mirroring today's shapes 1:1 so admin endpoints stay wire-compatible.
- Whether this is purely backend, or also the frontend's `localStorage` →
  some synced store (much bigger scope; default = no, keep `localStorage`).

## Default presets vs user-added presets visual inconsistency

User feedback: defaults (Schooner, Shot, etc.) feel different from
user-added presets in the Drink Types modal — defaults appear to "just
let you delete" while user-added ones say "manage". The render code
treats them identically apart from the `+ Barcode` vs `Manage` button
text on the barcode popover (defaults ship with no UPCs, user-adds via
scan come with one). Need to clarify what the user is seeing before
touching it.
