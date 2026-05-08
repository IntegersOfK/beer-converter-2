// All rendering + modal management. Reads/writes via state.js.

import { $, $$, fmt, escapeHtml, vibe } from './util.js?v=32';
import { ethanolOf, personStats, STD_DRINK_ML, ML_PER_OZ } from './calc.js?v=32';
import {
  state, getBenchmark, getUnitPref,
  addPreset, removePreset, setBenchmark,
  addDrink, removeDrink, updateDrink, updatePresetAndDrinks, setPersonName,
  addPerson, removePerson,
  rememberUpc, getUpcsForPreset, forgetUpc,
  switchSession, deleteSession, renameSession,
  setDrinkFlavour,
} from './state.js?v=32';
import { submitProduct } from './submit.js?v=32';
import { getFlavoursForName } from './products.js?v=32';

function fmtVol(ml) {
  return getUnitPref() === 'oz'
    ? `${fmt(ml / ML_PER_OZ, 1)} oz`
    : `${fmt(ml, 0)} ml`;
}

// Presets sorted with most-recently-used first, falling back to original
// array order for never-used ones. Chip trays read this so the drink you
// just logged sits at the front for one-tap re-use.
function presetsByRecency() {
  return state.presets
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const lb = b.p.lastUsedAt || 0;
      const la = a.p.lastUsedAt || 0;
      if (lb !== la) return lb - la;
      return a.i - b.i;   // stable for never-used presets
    })
    .map(x => x.p);
}

// Person badge label: A, B, … Z, then numeric (#27, #28, …) so we never run out.
function personBadge(idx) {
  return idx < 26 ? String.fromCharCode(65 + idx) : `#${idx + 1}`;
}

export function toggleCompareDetail() {
  compareDetailOpen = !compareDetailOpen;
  renderCompare();
}

// Which person the add-drink modal is currently targeting.
let addModalPersonIdx = 0;
let barcodeEditorPresetId = null;
// Which drink the edit modal is targeting.
let editPersonIdx = 0;
let editDrinkIdx = 0;
// Whether the multi-person comparison detail panel is expanded.
let compareDetailOpen = false;

// --- Rendering --------------------------------------------------------------
export function render() {
  renderPeople();
  renderCompare();
}

function renderPeople() {
  const grid = $('#peopleGrid');
  const bench = getBenchmark();

  // Preserve focus on a name input if the user is mid-edit.
  const active = document.activeElement;
  const activeNameIdx = active && active.matches && active.matches('.name-input')
    ? +active.dataset.personName : null;
  const activeSelStart = active && 'selectionStart' in active ? active.selectionStart : null;

  grid.innerHTML = '';

  const canRemove = state.people.length > 1;

  state.people.forEach((person, idx) => {
    const stats = personStats(person);
    const benchEquiv = bench ? stats.ethanolMl / ethanolOf(bench) : 0;

    const card = document.createElement('article');
    card.className = 'person';
    card.innerHTML = `
      <div class="person-head">
        <input class="name-input" data-person-name="${idx}" value="${escapeHtml(person.name)}" maxlength="16" spellcheck="false" />
        <span class="person-badge" title="Person ${personBadge(idx)}">${personBadge(idx)}</span>
        ${canRemove ? `<button class="x-btn person-remove" data-remove-person="${idx}" title="Remove ${escapeHtml(person.name)}" aria-label="Remove person">×</button>` : ''}
      </div>
      <div class="stats" data-stats="${idx}">
        <div class="stat hero" data-hero="${idx}">
          <div class="stat-label">Standard drinks</div>
          <div class="stat-value" title="1 standard drink = 17.05 ml pure ethanol">${fmt(stats.standardDrinks, 1)}</div>
          <div class="stat-sub" title="Total pure ethanol consumed">${fmt(stats.ethanolMl, 1)} ml ethanol</div>
        </div>
        <div class="stat" title="Number of drinks logged">
          <div class="stat-label">Drinks</div>
          <div class="stat-value">${stats.count}</div>
        </div>
        <div class="stat" title="${bench ? `Equivalent ${escapeHtml(bench.name.toLowerCase())} count at ${fmt(bench.abv,1)}% ABV` : ''}">
          <div class="stat-label">≈ ${escapeHtml(bench ? bench.name.toLowerCase() : '—')}</div>
          <div class="stat-value">${bench ? fmt(benchEquiv, 1) : '—'}</div>
          ${bench ? `<div class="stat-abv" title="${escapeHtml(bench.name)} alcohol by volume">@ ${fmt(bench.abv, 1)}%</div>` : ''}
        </div>
      </div>
      <div class="drinks" data-drinks="${idx}">
        ${person.drinks.length === 0
          ? `<div class="drinks-empty">No drinks logged yet</div>`
          : person.drinks.map((d, di) => `
            <div class="drink">
              <button class="drink-info drink-edit-btn" data-edit="${idx}:${di}" title="Edit this drink" aria-label="Edit drink">
                <div class="drink-name">${escapeHtml(d.name)}</div>
                ${d.flavour ? `<div class="drink-flavour">${escapeHtml(d.flavour)}</div>` : ''}
                <div class="drink-meta" title="Volume · alcohol by volume">${fmtVol(d.volumeMl)} · ${fmt(d.abv,1)}%</div>
              </button>
              <div class="drink-ethanol" title="Pure ethanol · ${fmt(ethanolOf(d)/STD_DRINK_ML,2)} standard drinks">+${fmt(ethanolOf(d),1)} ml ethanol</div>
              <button class="x-btn" data-remove="${idx}:${di}" title="Remove" aria-label="Remove drink">×</button>
            </div>
          `).join('')}
      </div>
      <div class="preset-tray" data-preset-tray="${idx}"></div>
      <div class="add-row">
        <button class="btn btn-primary" data-add="${idx}">+  Add drink</button>
        ${person.drinks.length > 0 ? `
          <button class="btn btn-same-again" data-add-previous="${idx}" title="Re-add ${escapeHtml(person.drinks[person.drinks.length - 1].name)}">↺ Same again</button>
        ` : ''}
      </div>
    `;
    grid.appendChild(card);

    // Preset chips for this person — most-recently-used first.
    const tray = card.querySelector(`[data-preset-tray="${idx}"]`);
    presetsByRecency().forEach(preset => {
      const chip = document.createElement('button');
      chip.className = 'preset-chip' + (preset.id === state.benchmarkPresetId ? ' benchmark' : '');
      chip.innerHTML = `${escapeHtml(preset.name)} <span class="meta">${fmtVol(preset.volumeMl)}·${fmt(preset.abv,1)}%</span>`;
      chip.title = `${fmtVol(preset.volumeMl)} · ${fmt(preset.abv,1)}% ABV · ${fmt(ethanolOf(preset),1)} ml ethanol · ${fmt(ethanolOf(preset)/STD_DRINK_ML,2)} std`;
      chip.addEventListener('click', () => logDrink(idx, presetToDrink(preset)));
      tray.appendChild(chip);
    });
  });

  // "+ Add person" tile, full-width below the cards.
  const addRow = document.createElement('div');
  addRow.className = 'add-person-row';
  addRow.innerHTML = `<button class="btn btn-add-person" id="btnAddPerson">+ Add person</button>`;
  grid.appendChild(addRow);

  // Events
  $$('[data-person-name]').forEach(input => {
    input.addEventListener('change', e => {
      setPersonName(+e.target.dataset.personName, e.target.value);
      renderCompare();
    });
  });
  $$('[data-edit]').forEach(btn => {
    btn.addEventListener('click', e => {
      const [pIdx, dIdx] = e.currentTarget.dataset.edit.split(':').map(Number);
      openEditModal(pIdx, dIdx);
    });
  });
  $$('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const [pIdx, dIdx] = e.currentTarget.dataset.remove.split(':').map(Number);
      removeDrink(pIdx, dIdx);
      vibe(8);
      render();
    });
  });
  $$('[data-add]').forEach(btn => {
    btn.addEventListener('click', e => openAddModal(+e.currentTarget.dataset.add));
  });
  $$('[data-add-previous]').forEach(btn => {
    btn.addEventListener('click', e => {
      const personIdx = +e.currentTarget.dataset.addPrevious;
      const person = state.people[personIdx];
      const prev = person?.drinks[person.drinks.length - 1];
      if (!prev) return;
      // One-tap re-add. Re-uses the original presetId if present, so chip
      // recency tracking still treats it as the same type.
      logDrink(personIdx, {
        name: prev.name,
        volumeMl: prev.volumeMl,
        abv: prev.abv,
        presetId: prev.presetId || null,
        flavour: prev.flavour || '',
      });
    });
  });
  $$('[data-remove-person]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = +e.currentTarget.dataset.removePerson;
      const person = state.people[idx];
      if (!person) return;
      if (person.drinks.length > 0 &&
          !confirm(`Remove ${person.name} and their ${person.drinks.length} logged drink${person.drinks.length === 1 ? '' : 's'}?`)) {
        return;
      }
      if (removePerson(idx)) { vibe(8); render(); }
    });
  });
  $('#btnAddPerson')?.addEventListener('click', () => {
    addPerson();
    vibe(8);
    render();
    // Focus the new card's name field so the user can rename right away.
    const newIdx = state.people.length - 1;
    const newInput = $(`[data-person-name="${newIdx}"]`);
    newInput?.focus();
    newInput?.select();
  });

  // Restore focus if needed.
  if (activeNameIdx !== null) {
    const el = $(`[data-person-name="${activeNameIdx}"]`);
    if (el) { el.focus(); if (activeSelStart !== null) try { el.setSelectionRange(activeSelStart, activeSelStart); } catch {} }
  }
}

function renderCompare() {
  const peopleStats = state.people.map(p => ({ name: p.name, s: personStats(p) }));
  const totalCount  = peopleStats.reduce((n, p) => n + p.s.count, 0);
  const bench  = getBenchmark();
  const main   = $('#compareMain');
  const equiv  = $('#compareEquiv');
  const bLabel = $('#benchmarkLabel');
  const expandBtn = $('#compareExpandBtn');
  const detail = $('#compareDetail');

  bLabel.textContent = bench ? `Benchmark · ${bench.name} @ ${fmt(bench.abv,1)}%` : '';
  bLabel.title = bench ? `${bench.name} is the reference drink — equivalence counts show how many of these each person has had` : '';

  const sessBtn = $('#btnCurrentSession');
  if (sessBtn) {
    const activeSess = state.sessions.find(s => s.id === state.activeSessionId);
    sessBtn.textContent = activeSess ? activeSess.name : '';
  }

  if (totalCount === 0) {
    main.innerHTML = `
      <div style="color:var(--ink-dim)">Log a drink to start tallying.</div>
      <ul class="hint-list">
        <li>Tap a chip on a card to add that drink type instantly</li>
        <li>Tap <b style="color:var(--ink)">+ Add drink</b> for custom entry or to scan a barcode</li>
        <li>The card header tap-edits each person's name</li>
      </ul>
    `;
    equiv.style.display = 'none';
    if (expandBtn) expandBtn.style.display = 'none';
    if (detail)    { detail.style.display = 'none'; detail.innerHTML = ''; }
    return;
  }

  // Drinkers ranked by ethanol — leader first. Non-drinkers sit out the sentence.
  const drinkers = peopleStats
    .filter(p => p.s.ethanolMl > 0)
    .sort((x, y) => y.s.ethanolMl - x.s.ethanolMl);

  const be     = bench ? ethanolOf(bench) : null;
  const bmUnit = bench ? escapeHtml(bench.name.toLowerCase()) : null;

  let sentence;
  if (drinkers.length === 1) {
    const only = drinkers[0];
    const dryCount = state.people.length - 1;
    const tail = dryCount === 0 ? ''
               : dryCount === 1 ? ` ${escapeHtml(peopleStats.find(p => p.s.ethanolMl === 0).name)} is still dry.`
               : ` Everyone else is still dry.`;
    if (bench) {
      const equiv = only.s.ethanolMl / be;
      sentence = `<b>${escapeHtml(only.name)}</b> has had <span class="big" title="${fmt(only.s.ethanolMl,1)} ml ethanol · ${fmt(only.s.standardDrinks,1)} standard drinks">${fmt(equiv,1)}</span> ${bmUnit}.${tail}`;
    } else {
      sentence = `<b>${escapeHtml(only.name)}</b> has had <span class="big" title="${fmt(only.s.ethanolMl,1)} ml ethanol">${fmt(only.s.standardDrinks,1)}</span> standard drinks.${tail}`;
    }
  } else {
    const leader = drinkers[0];
    const second = drinkers[1];
    const ratio  = leader.s.ethanolMl / second.s.ethanolMl;
    const tied   = Math.abs(ratio - 1) < 0.03;

    if (drinkers.length === 2) {
      if (tied) {
        if (bench) {
          const equiv = leader.s.ethanolMl / be;
          sentence = `<b>${escapeHtml(leader.name)}</b> and <b>${escapeHtml(second.name)}</b> are <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol each">neck&nbsp;&&nbsp;neck</span> — <span class="big" title="${fmt(equiv,1)} ${bmUnit} each">${fmt(equiv,1)}</span> ${bmUnit} each.`;
        } else {
          sentence = `<b>${escapeHtml(leader.name)}</b> and <b>${escapeHtml(second.name)}</b> are <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol each">neck&nbsp;&&nbsp;neck</span> on ethanol.`;
        }
      } else {
        sentence = `<b>${escapeHtml(leader.name)}</b> has had <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml vs ${fmt(second.s.ethanolMl,1)} ml ethanol">${fmt(ratio, 2)}×</span> the ethanol of <b>${escapeHtml(second.name)}</b>.`;
      }
    } else {
      // 3+ drinkers — leaderboard style.
      if (tied) {
        if (bench) {
          const equiv = leader.s.ethanolMl / be;
          sentence = `<b>${escapeHtml(leader.name)}</b> &amp; <b>${escapeHtml(second.name)}</b> are tied at the top — <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol each">${fmt(equiv,1)}</span> ${bmUnit} each.`;
        } else {
          sentence = `<b>${escapeHtml(leader.name)}</b> &amp; <b>${escapeHtml(second.name)}</b> are tied at the top with <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol">${fmt(leader.s.standardDrinks,1)}</span> std drinks.`;
        }
      } else {
        if (bench) {
          const leaderEquiv = leader.s.ethanolMl / be;
          sentence = `<b>${escapeHtml(leader.name)}</b> leads with <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol">${fmt(leaderEquiv,1)}</span> ${bmUnit} — <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml vs ${fmt(second.s.ethanolMl,1)} ml">${fmt(ratio, 2)}×</span> <b>${escapeHtml(second.name)}</b>.`;
        } else {
          sentence = `<b>${escapeHtml(leader.name)}</b> leads with <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml ethanol">${fmt(leader.s.standardDrinks,1)}</span> standard drinks — <span class="big" title="${fmt(leader.s.ethanolMl,1)} ml vs ${fmt(second.s.ethanolMl,1)} ml">${fmt(ratio, 2)}×</span> <b>${escapeHtml(second.name)}</b>.`;
        }
      }
    }
  }
  main.innerHTML = sentence;

  if (bench) {
    const be = ethanolOf(bench);
    const unit = bench.name.toLowerCase();
    const abvTag = `@ ${fmt(bench.abv,1)}%`;
    equiv.style.display = 'grid';
    equiv.innerHTML = peopleStats.map(p => {
      const eq = p.s.ethanolMl / be;
      return `
        <div>
          <span class="who">${escapeHtml(p.name)}</span>
          <span><span class="num" title="${fmt(p.s.ethanolMl,1)} ml ethanol ÷ ${fmt(be,1)} ml per ${escapeHtml(unit)}">${fmt(eq,1)}</span> ${escapeHtml(unit)}${eq === 1 ? '' : 's'} <span class="abv-tag" title="${escapeHtml(bench.name)} alcohol by volume">${abvTag}</span></span>
        </div>
      `;
    }).join('');
  } else {
    equiv.style.display = 'none';
  }

  // Detail panel: per-person breakdown plus a pairwise ratio matrix.
  // Only meaningful with 3+ people — for 2 people the headline already says everything.
  if (expandBtn && detail) {
    if (state.people.length >= 3) {
      expandBtn.style.display = '';
      expandBtn.title = 'Show per-person breakdown and pairwise ratio matrix';
      expandBtn.setAttribute('aria-expanded', compareDetailOpen ? 'true' : 'false');
      expandBtn.querySelector('.compare-expand-label').textContent =
        compareDetailOpen ? 'Hide detail' : 'Compare everyone';
      expandBtn.querySelector('.compare-expand-caret').textContent =
        compareDetailOpen ? '▴' : '▾';
      if (compareDetailOpen) {
        detail.style.display = '';
        detail.innerHTML = renderCompareDetail(peopleStats);
      } else {
        detail.style.display = 'none';
        detail.innerHTML = '';
      }
    } else {
      expandBtn.style.display = 'none';
      detail.style.display = 'none';
      detail.innerHTML = '';
    }
  }
}

// Per-row "Alice vs everyone" breakdowns + a compact pairwise matrix.
// Cells show how many times the row's ethanol the column person has had:
//   row Alice, col Bob  = Bob.ethanol / Alice.ethanol
// So a row reads as "Alice's day vs each other person".
function renderCompareDetail(peopleStats) {
  const sortedDrinkers = peopleStats
    .filter(p => p.s.ethanolMl > 0)
    .sort((x, y) => y.s.ethanolMl - x.s.ethanolMl);

  // Per-person breakdown card: leader has nothing to compare up to; others
  // get "X× behind leader" plus their own absolute tally.
  let breakdown = '';
  if (sortedDrinkers.length > 0) {
    const leader = sortedDrinkers[0];
    breakdown = `
      <div class="compare-breakdown">
        ${peopleStats.map(p => {
          const std = fmt(p.s.standardDrinks, 1);
          let tail;
          if (p.s.ethanolMl === 0) {
            tail = `<span class="vs-dry">still dry</span>`;
          } else if (p === leader || Math.abs(leader.s.ethanolMl / p.s.ethanolMl - 1) < 0.03) {
            tail = sortedDrinkers.length === 1 || p === leader
              ? `<span class="vs-leader">leading</span>`
              : `<span class="vs-leader">tied with ${escapeHtml(leader.name)}</span>`;
          } else {
            const behind = leader.s.ethanolMl / p.s.ethanolMl;
            tail = `<span class="vs-behind"><span class="num" title="${fmt(leader.s.ethanolMl,1)} ml vs ${fmt(p.s.ethanolMl,1)} ml ethanol">${fmt(behind, 2)}×</span> behind ${escapeHtml(leader.name)}</span>`;
          }
          return `
            <div class="compare-breakdown-row">
              <span class="who">${escapeHtml(p.name)}</span>
              <span class="std" title="${fmt(p.s.ethanolMl,1)} ml ethanol"><span class="num">${std}</span> std</span>
              ${tail}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  // Pairwise matrix. Ratios shown as col/row (column person relative to row person).
  const matrix = `
    <div class="compare-matrix-wrap">
      <div class="compare-matrix-title">Each row vs the others</div>
      <table class="compare-matrix">
        <thead>
          <tr>
            <th></th>
            ${peopleStats.map(p => `<th title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${peopleStats.map((row, ri) => `
            <tr>
              <th title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</th>
              ${peopleStats.map((col, ci) => {
                if (ri === ci) return `<td class="self" title="Same person">—</td>`;
                if (row.s.ethanolMl === 0 && col.s.ethanolMl === 0) return `<td class="dry" title="Both dry">·</td>`;
                if (row.s.ethanolMl === 0) return `<td class="lead" title="${escapeHtml(col.name)} has had infinitely more">∞</td>`;
                if (col.s.ethanolMl === 0) return `<td class="dry" title="${escapeHtml(col.name)} is dry">0</td>`;
                const r = col.s.ethanolMl / row.s.ethanolMl;
                const cls = Math.abs(r - 1) < 0.03 ? 'tie'
                          : r > 1 ? 'lead'
                          : 'behind';
                return `<td class="${cls}" title="${escapeHtml(col.name)}: ${fmt(col.s.ethanolMl,1)} ml · ${escapeHtml(row.name)}: ${fmt(row.s.ethanolMl,1)} ml ethanol">${fmt(r, 2)}×</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="compare-matrix-hint">Cell = column person's ethanol ÷ row person's ethanol.</div>
    </div>
  `;

  return breakdown + matrix;
}

function presetToDrink(preset) {
  return { name: preset.name, volumeMl: preset.volumeMl, abv: preset.abv, presetId: preset.id };
}

export function logDrink(personIdx, drink, { upc } = {}) {
  addDrink(personIdx, drink);
  vibe(12);
  submitProduct({
    upc,
    name: drink.name,
    abv: drink.abv,
    volumeMl: drink.volumeMl,
    flavour: drink.flavour || undefined,
    from: state.people[personIdx]?.name,
    people: state.people.map(p => p.name),
  });
  render();
  const hero = $(`[data-hero="${personIdx}"]`);
  if (hero) {
    hero.classList.remove('pulse');
    void hero.offsetWidth; // restart CSS animation
    hero.classList.add('pulse');
  }
}

// --- Add-drink modal -------------------------------------------------------
export function openAddModal(personIdx) {
  addModalPersonIdx = personIdx;
  $('#addModalTitle').textContent = `Add drink · ${state.people[personIdx].name}`;
  const tray = $('#addPresetTray');
  tray.innerHTML = '';
  presetsByRecency().forEach(preset => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (preset.id === state.benchmarkPresetId ? ' benchmark' : '');
    chip.innerHTML = `${escapeHtml(preset.name)} <span class="meta">${fmtVol(preset.volumeMl)}·${fmt(preset.abv,1)}%</span>`;
    chip.title = `${fmtVol(preset.volumeMl)} · ${fmt(preset.abv,1)}% ABV · ${fmt(ethanolOf(preset),1)} ml ethanol · ${fmt(ethanolOf(preset)/STD_DRINK_ML,2)} std`;
    chip.addEventListener('click', () => {
      logDrink(personIdx, presetToDrink(preset));
      closeModal();
    });
    tray.appendChild(chip);
  });
  resetCustomForm();
  $('#addModal').classList.add('open');
}

export function getAddModalPersonIdx() { return addModalPersonIdx; }

function resetCustomForm() {
  const u = getUnitPref();
  $('#customName').value = '';
  $('#customUnit').value = u;
  $('#customVolume').value = '';
  $('#customVolume').setAttribute('placeholder', u === 'oz' ? '16' : '473');
  $('#customAbv').value = '';
  $('#customUpc').value = '';
  $('#customKcal').value = '';
  // Default ON: most users want a one-tap "save as type" path; the save is
  // a no-op silently when no name is given (existing alert handles that).
  $('#saveAsPreset').checked = true;
  // Flavour stays hidden until a curated scan prefills it.
  const flavInput = $('#customFlavour');
  if (flavInput) flavInput.value = '';
  const flavField = $('#customFlavourField');
  if (flavField) flavField.style.display = 'none';
  updateEthanolPreview();
  updateSaveAsPresetCopy();
}

// Pre-fill the custom form after a barcode scan / lookup.
//
// `volumeMl` is set when the catalogue volume *is* the drink (e.g. a 355 ml
// beer can). For spirits / wine, callers pass `volumeMl: null` and a
// `volumePlaceholder` hint instead — pouring 44 ml of whisky from a 750 ml
// bottle is a per-drink decision the user has to make.
export function prefillCustomForm({
  name = '',
  volumeMl = null,
  abv = null,
  upc = '',
  kcalPer100ml = null,
  volumePlaceholder = null,
  flavour = '',
} = {}) {
  const u = getUnitPref();
  $('#customName').value = name || '';
  $('#customUnit').value = u;
  $('#customVolume').value = volumeMl != null && isFinite(volumeMl)
    ? (u === 'oz' ? +(volumeMl / ML_PER_OZ).toFixed(2) : Math.round(volumeMl))
    : '';
  $('#customAbv').value  = abv != null && isFinite(abv) ? (+abv).toFixed(1) : '';
  $('#customUpc').value  = upc || '';
  $('#customKcal').value = kcalPer100ml != null ? kcalPer100ml : '';
  const phMl = volumePlaceholder != null ? volumePlaceholder : 473;
  $('#customVolume').setAttribute('placeholder',
    u === 'oz' ? String(+(phMl / ML_PER_OZ).toFixed(1)) : String(Math.round(phMl)));
  // Flavour: only show the field when it's actually prefilled (curated scan).
  const flavInput = $('#customFlavour');
  const flavField = $('#customFlavourField');
  if (flavInput && flavField) {
    flavInput.value = flavour || '';
    flavField.style.display = flavour ? '' : 'none';
  }
  // Save-as-type defaults ON whether or not there's a UPC; matches the
  // resetCustomForm default. Scan flow especially benefits from this — the
  // whole point of a scan is usually to remember the product for next time.
  $('#saveAsPreset').checked = true;
  updateEthanolPreview();
  updateSaveAsPresetCopy();
}

// Recompute the toggle label + hint based on what's in the form.
// Called from input listeners so the copy stays honest as the user types.
export function updateSaveAsPresetCopy() {
  const upc      = $('#customUpc').value.trim();
  const name     = $('#customName').value.trim();
  const checked  = $('#saveAsPreset').checked;
  const label    = $('#saveAsPresetLabel');
  const hint     = $('#saveAsPresetHint');
  if (!label || !hint) return;

  label.textContent = upc
    ? 'Save as a drink type & remember this barcode'
    : 'Save this as a drink type';

  // Show a nudge ONLY when the user is one step away from a saved barcode.
  if (upc && checked && !name) {
    hint.textContent = 'Add a name above so this barcode can be remembered.';
    hint.style.display = '';
  } else if (upc && !checked) {
    hint.textContent = 'Barcode won’t be remembered unless this is checked.';
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

function updateEthanolPreview() {
  const v = getCustomVolumeMl();
  const a = parseFloat($('#customAbv').value);
  const el = $('#ethanolPreviewVal');
  if (!isFinite(v) || !isFinite(a) || v <= 0 || a < 0) {
    el.textContent = '—';
  } else {
    const e = v * a / 100;
    el.textContent = `${fmt(e,1)} ml  ·  ${fmt(e/STD_DRINK_ML, 2)} std`;
  }
}

function getCustomVolumeMl() {
  const raw = parseFloat($('#customVolume').value);
  if (!isFinite(raw)) return NaN;
  return $('#customUnit').value === 'oz' ? raw * ML_PER_OZ : raw;
}

function getNewPresetVolumeMl() {
  const raw = parseFloat($('#newPresetVolume').value);
  if (!isFinite(raw)) return NaN;
  return $('#newPresetUnit').value === 'oz' ? raw * ML_PER_OZ : raw;
}

export function submitCustomDrink() {
  const name = $('#customName').value.trim();
  const volumeMl = getCustomVolumeMl();
  const abv = parseFloat($('#customAbv').value);
  const upc = $('#customUpc').value.trim() || null;
  const kcalRaw = parseFloat($('#customKcal').value);
  const kcalPer100ml = isFinite(kcalRaw) ? kcalRaw : null;
  // Flavour is per-drink metadata only; never folded into the preset.
  const flavour = ($('#customFlavour')?.value || '').trim() || null;

  if (!isFinite(volumeMl) || !isFinite(abv) || volumeMl <= 0 || abv < 0 || abv > 100) {
    alert('Enter a valid volume and ABV (0–100%).'); return false;
  }

  // If the user has a barcode in the form they almost always want it remembered.
  // Hard-blocking the submit when "save as type" is unchecked but a UPC is
  // present has burned users (they think the drink saved but the UPC didn't).
  // Behaviour now:
  //   - toggle ON  + name given  → make a preset, link UPC to it
  //   - toggle ON  + no name     → ask for a name (we need one to make a preset)
  //   - toggle OFF + UPC present → just log the drink, leave UPC unsaved
  //                                (matches the toggle-off intent)
  let presetId = null;
  if ($('#saveAsPreset').checked) {
    if (!name) { alert('Enter a name above so this drink can be saved as a type.'); return false; }
    const preset = addPreset({ name, volumeMl, abv, kcalPer100ml, upc });
    presetId = preset.id;
  }

  logDrink(addModalPersonIdx, {
    name: name || `${fmt(volumeMl,0)} ml · ${fmt(abv,1)}%`,
    volumeMl,
    abv,
    presetId,
    flavour,
  }, { upc });
  closeModal();
  return true;
}

// --- Presets modal ---------------------------------------------------------
export function openPresetsModal() {
  renderPresetList();
  $('#newPresetName').value = '';
  $('#newPresetVolume').value = '';
  $('#newPresetUnit').value = getUnitPref();
  $('#newPresetAbv').value = '';
  $('#presetsModal').classList.add('open');
}

function renderPresetList() {
  const list = $('#presetList');
  list.innerHTML = '';
  state.presets.forEach(preset => {
    const upcs = getUpcsForPreset(preset.id);
    const editingBarcodes = barcodeEditorPresetId === preset.id;
    const row = document.createElement('div');
    row.className = 'preset-list-item' + (preset.id === state.benchmarkPresetId ? ' active' : '');
    row.innerHTML = `
      <div class="preset-row-main">
        <div class="info">
          <div class="name">${escapeHtml(preset.name)}</div>
          <div class="meta" title="Volume · ABV · pure ethanol per drink · ${fmt(ethanolOf(preset)/STD_DRINK_ML,2)} standard drinks">${fmtVol(preset.volumeMl)} · ${fmt(preset.abv,1)}% · ${fmt(ethanolOf(preset),1)} ml ethanol</div>
        </div>
        <button class="star-btn" title="Set as benchmark" data-star="${preset.id}" aria-label="Set as benchmark">★</button>
        <button class="x-btn" title="Delete" data-del-preset="${preset.id}" aria-label="Delete">×</button>
      </div>
      <div class="preset-upcs${editingBarcodes ? ' editing' : ''}">
        <div class="upc-summary">
          <span class="upc-list-label">Barcodes</span>
          ${upcs.length === 0
            ? '<span class="upc-empty">No barcode</span>'
            : `<span class="upc-count">${upcs.length} saved</span>`}
        </div>
        ${upcs.length === 0 ? '' : `
          <div class="upc-chip-row">
            ${upcs.map(u => `
              <span class="upc-chip">
                <span class="mono">${escapeHtml(u)}</span>
                <button class="upc-x" data-forget-upc="${escapeHtml(u)}" title="Forget this barcode" aria-label="Forget barcode">×</button>
              </span>
            `).join('')}
          </div>
        `}
        <button class="upc-manage-btn" data-toggle-upcs="${preset.id}">
          ${editingBarcodes ? 'Done' : (upcs.length ? 'Manage' : '+ Barcode')}
        </button>
        ${editingBarcodes ? `
          <div class="upc-popover">
            <label for="upc-${preset.id}">Add barcode</label>
            <div class="upc-popover-row">
              <input class="mono upc-add-input" id="upc-${preset.id}" type="text" inputmode="numeric"
                     placeholder="0 12345 67890 5" data-add-upc-for="${preset.id}" autocomplete="off" />
              <button class="upc-add-btn" data-add-upc-submit="${preset.id}" title="Link this barcode" aria-label="Add barcode">+</button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
    list.appendChild(row);
  });
  $$('[data-star]', list).forEach(btn => {
    btn.addEventListener('click', e => { vibe(12); setBenchmark(e.currentTarget.dataset.star); renderPresetList(); render(); });
  });
  $$('[data-del-preset]', list).forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.currentTarget.dataset.delPreset;
      const linked = getUpcsForPreset(id);
      if (linked.length > 0 && !confirm(
        `Remove "${state.presets.find(p => p.id === id)?.name}" and ${linked.length} linked barcode${linked.length === 1 ? '' : 's'}?`
      )) return;
      const ok = removePreset(id);
      if (!ok) alert('Keep at least one drink type.');
      else {
        // Hard-detach the UPCs we just orphaned so they don't dangle in the cache.
        linked.forEach(u => forgetUpc(u));
        if (barcodeEditorPresetId === id) barcodeEditorPresetId = null;
        renderPresetList();
        render();
      }
    });
  });
  // Detach a single barcode from its preset.
  $$('[data-forget-upc]', list).forEach(btn => {
    btn.addEventListener('click', e => {
      const upc = e.currentTarget.dataset.forgetUpc;
      if (forgetUpc(upc)) renderPresetList();
    });
  });
  $$('[data-toggle-upcs]', list).forEach(btn => {
    btn.addEventListener('click', e => {
      const id = e.currentTarget.dataset.toggleUpcs;
      barcodeEditorPresetId = barcodeEditorPresetId === id ? null : id;
      renderPresetList();
      if (barcodeEditorPresetId) {
        const input = list.querySelector(`[data-add-upc-for="${barcodeEditorPresetId}"]`);
        input?.focus();
      }
    });
  });
  // Attach a new barcode to an existing preset.
  $$('[data-add-upc-submit]', list).forEach(btn => {
    btn.addEventListener('click', e => {
      const presetId = e.currentTarget.dataset.addUpcSubmit;
      const input = list.querySelector(`[data-add-upc-for="${presetId}"]`);
      if (!input) return;
      const upc = input.value.trim();
      if (!upc) return;
      if (rememberUpc(upc, presetId)) {
        const preset = state.presets.find(p => p.id === presetId);
        if (preset) submitProduct({ upc, name: preset.name, abv: preset.abv, volumeMl: preset.volumeMl, people: state.people.map(p => p.name) });
        input.value = ''; barcodeEditorPresetId = presetId; renderPresetList();
      }
    });
  });
  // Allow hitting Enter inside the inline UPC input as a shortcut for the +.
  $$('[data-add-upc-for]', list).forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const btn = list.querySelector(`[data-add-upc-submit="${input.dataset.addUpcFor}"]`);
      btn?.click();
    });
  });
}

export function submitNewPreset() {
  const name = $('#newPresetName').value.trim();
  const volumeMl = getNewPresetVolumeMl();
  const abv = parseFloat($('#newPresetAbv').value);
  if (!name || !isFinite(volumeMl) || !isFinite(abv) || volumeMl <= 0 || abv < 0 || abv > 100) {
    alert('Enter a name, valid volume, and ABV.'); return false;
  }
  addPreset({ name, volumeMl, abv });
  $('#newPresetName').value = '';
  $('#newPresetVolume').value = '';
  $('#newPresetAbv').value = '';
  renderPresetList();
  render();
  return true;
}

// --- Sessions modal --------------------------------------------------------
export function openSessionsModal() {
  renderSessionList();
  $('#sessionsModal').classList.add('open');
}

function renderSessionList() {
  const list = $('#sessionList');
  list.innerHTML = '';
  const sorted = [...state.sessions].reverse();
  sorted.forEach(sess => {
    const isActive = sess.id === state.activeSessionId;
    const drinks = sess.people.reduce((n, p) => n + p.drinks.length, 0);
    const date = new Date(sess.ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    const peopleNames = sess.people.map(p => p.name).filter(Boolean);
    const peopleStr = peopleNames.length
      ? peopleNames.join(' · ')
      : '(no one yet)';
    const item = document.createElement('div');
    item.className = 'session-item' + (isActive ? ' active' : '');
    item.innerHTML = `
      <div class="session-item-info">
        <input class="session-item-name session-name-input" data-rename-session="${escapeHtml(sess.id)}"
               value="${escapeHtml(sess.name)}" maxlength="40" spellcheck="false"
               aria-label="Rename session" />
        <div class="session-item-people" title="${escapeHtml(peopleStr)}">${escapeHtml(peopleStr)}</div>
        <div class="session-item-meta">${escapeHtml(date)} · ${drinks} drink${drinks === 1 ? '' : 's'}</div>
      </div>
      <button class="btn btn-ghost session-switch-btn" data-switch-session="${escapeHtml(sess.id)}"${isActive ? ' disabled' : ''}>
        ${isActive ? 'current' : 'open'}
      </button>
      <button class="x-btn" data-del-session="${escapeHtml(sess.id)}" aria-label="Delete session"${state.sessions.length <= 1 ? ' disabled' : ''}>×</button>
    `;
    list.appendChild(item);
  });

  // Inline rename: commit on blur or Enter; Escape reverts.
  list.querySelectorAll('[data-rename-session]').forEach(input => {
    const original = input.value;
    const commit = () => {
      const id = input.dataset.renameSession;
      if (input.value === input.dataset.lastValue) return;
      input.dataset.lastValue = input.value;
      renameSession(id, input.value);
      // Reflect any clamping/fallback the state did.
      const sess = state.sessions.find(s => s.id === id);
      if (sess) input.value = sess.name;
      // Update the tally tag if we just renamed the active session.
      if (id === state.activeSessionId) {
        const tag = $('#btnCurrentSession');
        if (tag) tag.textContent = sess.name;
      }
    };
    input.dataset.lastValue = original;
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = original; input.blur(); }
    });
    // Don't let a click on the name input bubble up to anything.
    input.addEventListener('click', e => e.stopPropagation());
  });

  list.querySelectorAll('[data-switch-session]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      switchSession(el.dataset.switchSession);
      closeModal();
      render();
    });
  });

  list.querySelectorAll('[data-del-session]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.delSession;
      const sess = state.sessions.find(s => s.id === id);
      const drinks = sess ? sess.people.reduce((n, p) => n + p.drinks.length, 0) : 0;
      const msg = drinks > 0
        ? `Delete "${sess.name}" and its ${drinks} logged drink${drinks === 1 ? '' : 's'}?`
        : `Delete "${sess.name}"?`;
      if (!confirm(msg)) return;
      deleteSession(id);
      render();
      renderSessionList();
    });
  });
}

// --- Shared ---------------------------------------------------------------
export function closeModal() {
  $$('.modal-overlay').forEach(m => m.classList.remove('open'));
}

// Expose the preview updater for app.js input wiring.
export { updateEthanolPreview };

// --- Edit logged drink modal -----------------------------------------------
function updateEditEthanolPreview() {
  const raw = parseFloat($('#editVolume').value);
  const unit = $('#editUnit').value;
  const v = unit === 'oz' ? raw * ML_PER_OZ : raw;
  const a = parseFloat($('#editAbv').value);
  const el = $('#editEthanolPreviewVal');
  if (!isFinite(v) || !isFinite(a) || v <= 0 || a < 0) {
    el.textContent = '—';
  } else {
    const e = v * a / 100;
    el.textContent = `${fmt(e,1)} ml  ·  ${fmt(e/STD_DRINK_ML, 2)} std`;
  }
}

// Captured at modal-open so we can detect what changed and toggle controls.
let editOriginal = null;

export function openEditModal(personIdx, drinkIdx) {
  editPersonIdx = personIdx;
  editDrinkIdx = drinkIdx;
  const drink = state.people[personIdx]?.drinks[drinkIdx];
  if (!drink) return;

  const u = getUnitPref();
  $('#editName').value = drink.name || '';
  $('#editUnit').value = u;
  $('#editVolume').value = u === 'oz'
    ? +(drink.volumeMl / ML_PER_OZ).toFixed(2)
    : Math.round(drink.volumeMl);
  $('#editAbv').value = (+drink.abv).toFixed(1);
  const flavInput = $('#editFlavour');
  if (flavInput) flavInput.value = drink.flavour || '';
  const flavList = $('#editFlavourList');
  if (flavList) {
    const opts = getFlavoursForName(drink.name || '');
    flavList.innerHTML = opts.map(f => `<option value="${escapeHtml(f)}">`).join('');
  }
  updateEditEthanolPreview();

  // Linked-to label is always visible when the drink is linked. The scope
  // toggle inside (one vs all) only appears once n/v/a actually changes —
  // gated by updateEditModeVisibility.
  const preset = drink.presetId ? state.presets.find(p => p.id === drink.presetId) : null;
  const linkedSection = $('#editLinkedSection');
  if (preset) {
    linkedSection.style.display = '';
    $('#editLinkedOrnament').textContent = `Linked to saved drink type "${preset.name}"`;
    $('#editScopeAllLabel').textContent = `All "${preset.name}" drinks (update the saved type)`;
    $('#editScopeOne').checked = true;
  } else {
    linkedSection.style.display = 'none';
  }

  // Capture originals + apply initial visibility.
  editOriginal = {
    name: drink.name || '',
    volumeMl: +drink.volumeMl,
    abv: +drink.abv,
    flavour: drink.flavour || '',
  };
  // Bind change listeners (idempotent — listener objects are recreated each
  // open but point to the same DOM nodes, so the prior listeners are still
  // attached. The visibility check is cheap, so duplicate firings are fine.)
  ['#editName', '#editVolume', '#editAbv', '#editUnit', '#editFlavour'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', updateEditModeVisibility);
    el.addEventListener('change', updateEditModeVisibility);
  });
  updateEditModeVisibility();

  $('#editDrinkModal').classList.add('open');
}

// Compare current form values to the captured originals. Bottom Save button
// + scope toggle gate on n/v/a changes; flavour gets its own inline button.
function updateEditModeVisibility() {
  if (!editOriginal) return;
  const drink = state.people[editPersonIdx]?.drinks[editDrinkIdx];
  if (!drink) return;

  const curName = $('#editName').value.trim();
  const curVolRaw = parseFloat($('#editVolume').value);
  const curVol = $('#editUnit').value === 'oz' ? curVolRaw * ML_PER_OZ : curVolRaw;
  const curAbv = parseFloat($('#editAbv').value);
  const curFlav = ($('#editFlavour')?.value || '').trim();

  const nvaChanged =
    curName !== editOriginal.name ||
    (Number.isFinite(curVol) && Math.abs(curVol - editOriginal.volumeMl) > 0.01) ||
    (Number.isFinite(curAbv) && Math.abs(curAbv - editOriginal.abv) > 0.001);
  const flavourChanged = curFlav !== editOriginal.flavour;

  $('#btnSaveEditDrink').style.display = nvaChanged ? '' : 'none';
  // Scope toggle inside the linked section: only shown when there's an n/v/a
  // change to scope. The "Linked to..." label itself stays visible regardless.
  const scopeToggle = $('#editScopeToggle');
  if (scopeToggle) scopeToggle.style.display = (drink.presetId && nvaChanged) ? '' : 'none';
  // Inline flavour save: only shown when flavour is the *only* change so the
  // user can commit the flavour without going through the n/v/a save flow.
  $('#btnSaveEditFlavour').style.display = (flavourChanged && !nvaChanged) ? '' : 'none';
}

export function saveEditFlavourOnly() {
  if (!editOriginal) return;
  const flavour = ($('#editFlavour')?.value || '').trim();
  setDrinkFlavour(editPersonIdx, editDrinkIdx, flavour);
  closeModal();
  render();
}

export function submitEditDrink() {
  const name = $('#editName').value.trim();
  const raw = parseFloat($('#editVolume').value);
  const unit = $('#editUnit').value;
  const volumeMl = unit === 'oz' ? raw * ML_PER_OZ : raw;
  const abv = parseFloat($('#editAbv').value);
  const flavour = ($('#editFlavour')?.value || '').trim();

  if (!isFinite(volumeMl) || !isFinite(abv) || volumeMl <= 0 || abv < 0 || abv > 100) {
    alert('Enter a valid volume and ABV (0–100%).'); return;
  }

  const drink = state.people[editPersonIdx]?.drinks[editDrinkIdx];
  if (!drink) { closeModal(); return; }

  if (drink.presetId && $('#editScopeAll').checked) {
    // "All drinks of this type" path — bulk-update the preset and every linked
    // drink, then set this drink's flavour separately. Using setDrinkFlavour
    // avoids breaking the preset link (updateDrink would null presetId, but
    // n/v/a still match the freshly-updated preset, so we want to keep it).
    updatePresetAndDrinks(drink.presetId, { name, volumeMl, abv });
    setDrinkFlavour(editPersonIdx, editDrinkIdx, flavour);
  } else {
    updateDrink(editPersonIdx, editDrinkIdx, { name, volumeMl, abv, flavour });
  }

  closeModal();
  render();
}

export { updateEditEthanolPreview };
