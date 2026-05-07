# TODO

Backlog of UX nits and feature requests. Not in priority order.

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
