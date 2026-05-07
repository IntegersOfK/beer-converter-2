# TODO

Backlog of UX nits and feature requests. Not in priority order.

---

## Plan: Products + UPCs + Flavours (multi-phase)

Goal: replace the flat per-UPC curated model with an explicit
**product → UPCs (with flavours)** relationship. Multi-flavour packs
(White Claw, Truly, Mike's, etc.) currently force the curator to fight
the data model; this fixes that.

### Data model (full migration, no back-compat in storage)

Two new files alongside `server/index.js`:

```
products.json
[
  {
    "id":         "p_whiteclaw_a4f2",
    "name":       "White Claw",
    "abv":        5.0,
    "volumeMl":   355,
    "createdAt":  "2026-…",
    "updatedAt":  "2026-…"
  }
]

upcs.json
[
  {
    "upc":       "087000007604",
    "productId": "p_whiteclaw_a4f2",
    "flavour":   "Grapefruit",
    "addedAt":   "2026-…"
  }
]
```

Product `id` is a slug + short hash so renames are cheap (only the
products row updates, every UPC row is unaffected).

`/catalog.json` (public, frontend-facing) **stays a flat array** so the
frontend index doesn't have to change shape. Server JOINs before
emitting:

```json
[
  { "upc": "087…", "productId": "p_whiteclaw_a4f2", "name": "White Claw",
    "flavour": "Grapefruit", "abv": 5.0, "volumeMl": 355 }
]
```

### Migration (one-shot, runs at server boot if products.json is missing)

1. Read existing `curated.json`.
2. Group entries by exact `name` → one product each. Pick the most-common
   `abv` / `volumeMl` across the group (warn to console on disagreement).
3. Generate product id = `p_${slug(name)}_${4-char hash}`.
4. Each curated UPC → row in `upcs.json` with `productId`, `flavour: null`.
5. Write `products.json` + `upcs.json`. Move `curated.json` to
   `curated.legacy.json` (don't delete — easy rollback).
6. From here on, `curated.json` is no longer read or written.

---

### Phase 1 — server foundation (no UI changes; app keeps working)

- `server/index.js`:
  - Add migration on boot (above).
  - New endpoints under `${ADMIN_PATH}/api/`:
    - `GET  products`         — list all products + their upcs
    - `POST product`          — upsert `{ id?, name, abv, volumeMl }`
    - `DELETE product/:id`    — remove product and all its upcs
    - `POST upc`              — upsert `{ upc, productId, flavour? }`
    - `DELETE upc/:upc`       — detach a UPC
  - `GET /catalog.json` — join products + upcs, emit flat shape with
    optional `flavour`.
  - Retire `POST /api/curated`. Update old admin GUI to call new
    endpoints (Phase 2 will replace the GUI; for now wire them so the
    legacy "save to catalogue" still works).
- `js/products.js`:
  - `mergeCurated` accepts `flavour`, `productId` on each entry.
  - In-memory product object now carries optional `flavour`,
    `productId`. No frontend behaviour change yet.

Verifies: `/catalog.json` still produces same lookup behaviour;
no scanned-UPC flow broken.

---

### Phase 2 — admin GUI revamp

Replace the current curated section with a **Products** view.

For each product, one card:

```
┌──────────────────────────────────────┐
│  Name [White Claw         ]  [Save]  │
│  ABV  [5.0]   Vol [355] ml   [Del]   │
│  ──────────────────────────────────  │
│  087000007604   Grapefruit       ×   │
│  087000007611   Mango            ×   │
│  087000007628   Natural Lime     ×   │
│  + Add UPC: [______]  Flavour [___] [+]
└──────────────────────────────────────┘
```

- Top-row save propagates to all UPCs (server side: just updates the
  one product row; UPCs are unaffected).
- "+ Add UPC" inline form posts `POST /api/upc` and re-renders.

Pending-queue card gets two save modes:
- **New product** (default — same fields as today + flavour).
- **Add to existing product** — dropdown of product names. Server creates
  a new UPC row attached to that product. Optional flavour input.

Suggestion chips evolve: when one matches an existing product with high
confidence, show a one-click "Add this UPC to [White Claw] →" button
that drops it under that product with empty flavour.

Manual-add form gets two tabs ("New product" / "Add UPC to existing").

---

### Phase 3 — frontend scan + preset behaviour

- Custom-drink modal gains an optional **Flavour** input below the name.
  - Hidden / collapsed when empty (so the UI stays clean for non-curated
    items).
  - When you scan a curated UPC, prefill `name` from product, `flavour`
    from UPC row.
- "Save as type" (preset) stores **only** the product fields:
  `name`, `abv`, `volumeMl`. Flavour is intentionally dropped — the
  preset is the product, not the specific flavour.
- Quick-add chip click logs the drink with `name` only, no flavour.
- Drink record in localStorage gains optional `flavour` field.
- Scanned UPC → preset auto-link still uses `presetId`; the link is
  product-level, so the next scan of *any* flavour of the same product
  hits the same preset.

---

### Phase 4 — flavour autocomplete + display

- Edit-drink modal: add Flavour input with `<datalist>` populated from
  `/catalog.json` filtered by the drink's product name.
  - User can pick a known flavour, type a new one, or leave blank.
  - Saves to the drink record only.
- Drink list display: when `flavour` is set, render
  `${name} · ${flavour}` (or em-dash separator — pick one).
- Tally compare strip + final report use the combined string.

---

### Phase 5 — polish (skippable)

- Admin: "Merge product" — pick two products, merge their UPC lists into
  one. Useful when curator created "White Claw" and "WhiteClaw" by
  accident.
- Admin: rename suggestions when two products have very similar names.
- One-time scan of existing logged drinks to detect "Name — Flavour"
  string patterns and split them out into the new fields. Probably not
  worth it.

---

### Open questions / things to decide later

- Do we want flavour searchable as a UPC-cache key on the device? (Today
  the cache is UPC → presetId; flavour lives on the *drink record*, so
  no.)
- When a user has a non-curated UPC scan with a typed flavour, do we
  surface that flavour as a hint when curating later? (Could be a nice
  feedback loop — submitted flavour text from `/submit` could appear as
  a suggestion in the admin's flavour field. Out of scope for first
  pass.)
- For the `/submit` payload: should the user app also send their typed
  flavour to the central log so the curator sees real-world flavours?
  Probably yes, gated behind an opt-in or always-on with the same
  privacy posture as existing `/submit`. Decide in Phase 3.

---

## Iconography

The header icon row (Theme · Sessions · Presets · Report · Reset) has two
icons that look too similar:

- **Sessions** is currently the layered-cube/stack icon. Hard to read as
  "switch sessions". Possible replacement: a chair, a deck of cards, a
  numbered tab/folder, or something else clearly suggesting "pick one of
  several rooms".
- **Drink types** ("presets") is currently the horizontal-bars icon. That
  reads as a generic menu, not "manage drink types". A martini/pint glass
  would map better — but **don't pick an icon that conflicts with the
  bar/beach theme toggle** (currently sun ↔ moon). If "bar mode" ever
  picks up a glass icon, drink-types would clash. Pick the icons together
  so the metaphor is coherent.

## Quick-add ergonomics (from a user)

- **"Add previous drink"** button next to Add drink — one-tap re-add of
  the most recent drink for that person.
- **Most-recently-entered drink type** should appear as the first chip in
  the quick-add tray (currently sorted by preset list order).
- **"Save this drink" checkbox should default to checked** in the custom
  drink form. (Today it's unchecked unless a UPC is present.)

## Admin discoverability

- Small link at the bottom of the page (footnote area) that takes the
  curator to the admin path. Wording should NOT imply to regular users
  that there's anything for them to do there — e.g. "Curator" or "Admin"
  in muted ink-soft, not a call-to-action.
