// All rendering + modal management. Reads/writes via state.js.

import { $, $$, fmt, escapeHtml, vibe } from './util.js';
import { ethanolOf, personStats, STD_DRINK_ML, ML_PER_OZ } from './calc.js';
import {
  state, saveState, getBenchmark,
  addPreset, removePreset, setBenchmark,
  addDrink, removeDrink, setPersonName,
} from './state.js';

// Which person the add-drink modal is currently targeting.
let addModalPersonIdx = 0;

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

  state.people.forEach((person, idx) => {
    const stats = personStats(person);
    const benchEquiv = bench ? stats.ethanolMl / ethanolOf(bench) : 0;

    const card = document.createElement('article');
    card.className = 'person';
    card.innerHTML = `
      <div class="person-head">
        <input class="name-input" data-person-name="${idx}" value="${escapeHtml(person.name)}" maxlength="16" spellcheck="false" />
        <span class="person-badge">${idx === 0 ? 'A' : 'B'}</span>
      </div>
      <div class="stats" data-stats="${idx}">
        <div class="stat hero" data-hero="${idx}">
          <div class="stat-label">Standard drinks</div>
          <div class="stat-value">${fmt(stats.standardDrinks, 1)}</div>
          <div class="stat-sub">${fmt(stats.ethanolMl, 1)} ml ethanol</div>
        </div>
        <div class="stat">
          <div class="stat-label">Drinks</div>
          <div class="stat-value">${stats.count}</div>
        </div>
        <div class="stat">
          <div class="stat-label">≈ ${escapeHtml(bench ? bench.name.toLowerCase() : '—')}</div>
          <div class="stat-value">${bench ? fmt(benchEquiv, 1) : '—'}</div>
          ${bench ? `<div class="stat-abv">@ ${fmt(bench.abv, 1)}%</div>` : ''}
        </div>
      </div>
      <div class="drinks" data-drinks="${idx}">
        ${person.drinks.length === 0
          ? `<div class="drinks-empty">No drinks logged yet</div>`
          : person.drinks.map((d, di) => `
            <div class="drink">
              <div class="drink-info">
                <div class="drink-name">${escapeHtml(d.name)}</div>
                <div class="drink-meta">${fmt(d.volumeMl,0)} ml · ${fmt(d.abv,1)}%</div>
              </div>
              <div class="drink-ethanol">+${fmt(ethanolOf(d),1)} ml</div>
              <button class="x-btn" data-remove="${idx}:${di}" title="Remove" aria-label="Remove drink">×</button>
            </div>
          `).join('')}
      </div>
      <div class="preset-tray" data-preset-tray="${idx}"></div>
      <div class="add-row">
        <button class="btn btn-primary" data-add="${idx}">+  Add drink</button>
      </div>
    `;
    grid.appendChild(card);

    // Preset chips for this person.
    const tray = card.querySelector(`[data-preset-tray="${idx}"]`);
    state.presets.forEach(preset => {
      const chip = document.createElement('button');
      chip.className = 'preset-chip' + (preset.id === state.benchmarkPresetId ? ' benchmark' : '');
      chip.innerHTML = `${escapeHtml(preset.name)} <span class="meta">${fmt(preset.volumeMl,0)}·${fmt(preset.abv,1)}%</span>`;
      chip.addEventListener('click', () => logDrink(idx, presetToDrink(preset)));
      tray.appendChild(chip);
    });
  });

  // Events
  $$('[data-person-name]').forEach(input => {
    input.addEventListener('change', e => {
      setPersonName(+e.target.dataset.personName, e.target.value);
      renderCompare();
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

  // Restore focus if needed.
  if (activeNameIdx !== null) {
    const el = $(`[data-person-name="${activeNameIdx}"]`);
    if (el) { el.focus(); if (activeSelStart !== null) try { el.setSelectionRange(activeSelStart, activeSelStart); } catch {} }
  }
}

function renderCompare() {
  const [a, b] = state.people;
  const sa = personStats(a), sb = personStats(b);
  const bench = getBenchmark();
  const main  = $('#compareMain');
  const equiv = $('#compareEquiv');
  const bLabel = $('#benchmarkLabel');

  bLabel.textContent = bench ? `Benchmark · ${bench.name} @ ${fmt(bench.abv,1)}%` : '';

  if (sa.count === 0 && sb.count === 0) {
    main.innerHTML = `
      <div style="color:var(--ink-dim)">Log a drink to start tallying.</div>
      <ul class="hint-list">
        <li>Tap a chip on a card to add that drink type instantly</li>
        <li>Tap <b style="color:var(--ink)">+ Add drink</b> for custom entry or to scan a barcode</li>
        <li>The card header tap-edits each person's name</li>
      </ul>
    `;
    equiv.style.display = 'none';
    return;
  }

  let sentence;
  if (sa.ethanolMl === 0) {
    sentence = `<b>${escapeHtml(b.name)}</b> has had <span class="big">${fmt(sb.standardDrinks,1)}</span> standard drinks. <b>${escapeHtml(a.name)}</b> is still dry.`;
  } else if (sb.ethanolMl === 0) {
    sentence = `<b>${escapeHtml(a.name)}</b> has had <span class="big">${fmt(sa.standardDrinks,1)}</span> standard drinks. <b>${escapeHtml(b.name)}</b> is still dry.`;
  } else {
    const ratio = sa.ethanolMl / sb.ethanolMl;
    if (Math.abs(ratio - 1) < 0.03) {
      sentence = `<b>${escapeHtml(a.name)}</b> and <b>${escapeHtml(b.name)}</b> are <span class="big">neck&nbsp;&&nbsp;neck</span> on ethanol.`;
    } else if (ratio > 1) {
      sentence = `<b>${escapeHtml(a.name)}</b> has had <span class="big">${fmt(ratio, 2)}×</span> the ethanol of <b>${escapeHtml(b.name)}</b>.`;
    } else {
      sentence = `<b>${escapeHtml(b.name)}</b> has had <span class="big">${fmt(1/ratio, 2)}×</span> the ethanol of <b>${escapeHtml(a.name)}</b>.`;
    }
  }
  main.innerHTML = sentence;

  if (bench) {
    const be = ethanolOf(bench);
    const aEq = sa.ethanolMl / be;
    const bEq = sb.ethanolMl / be;
    const unit = bench.name.toLowerCase();
    const abvTag = `@ ${fmt(bench.abv,1)}%`;
    equiv.style.display = 'grid';
    equiv.innerHTML = `
      <div>
        <span class="who">${escapeHtml(a.name)}</span>
        <span><span class="num">${fmt(aEq,1)}</span> ${escapeHtml(unit)}${aEq === 1 ? '' : 's'} <span class="abv-tag">${abvTag}</span></span>
      </div>
      <div>
        <span class="who">${escapeHtml(b.name)}</span>
        <span><span class="num">${fmt(bEq,1)}</span> ${escapeHtml(unit)}${bEq === 1 ? '' : 's'} <span class="abv-tag">${abvTag}</span></span>
      </div>
    `;
  } else {
    equiv.style.display = 'none';
  }
}

function presetToDrink(preset) {
  return { name: preset.name, volumeMl: preset.volumeMl, abv: preset.abv, presetId: preset.id };
}

export function logDrink(personIdx, drink) {
  addDrink(personIdx, drink);
  vibe(12);
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
  state.presets.forEach(preset => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (preset.id === state.benchmarkPresetId ? ' benchmark' : '');
    chip.innerHTML = `${escapeHtml(preset.name)} <span class="meta">${fmt(preset.volumeMl,0)}·${fmt(preset.abv,1)}%</span>`;
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
  $('#customName').value = '';
  $('#customVolume').value = '';
  $('#customAbv').value = '';
  $('#customUpc').value = '';
  $('#customKcal').value = '';
  $('#saveAsPreset').checked = false;
  updateEthanolPreview();
}

// Pre-fill the custom form after a barcode scan / lookup.
export function prefillCustomForm({ name = '', volumeMl = null, abv = null, upc = '', kcalPer100ml = null }) {
  $('#customName').value = name || '';
  $('#customVolume').value = volumeMl != null ? Math.round(volumeMl) : '';
  $('#customUnit').value = 'ml';
  $('#customAbv').value = abv != null ? (+abv).toFixed(1) : '';
  $('#customUpc').value = upc || '';
  $('#customKcal').value = kcalPer100ml != null ? kcalPer100ml : '';
  // If we got the barcode, suggest saving as a preset so rescans are instant.
  $('#saveAsPreset').checked = !!upc;
  updateEthanolPreview();
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

  if (!isFinite(volumeMl) || !isFinite(abv) || volumeMl <= 0 || abv < 0 || abv > 100) {
    alert('Enter a valid volume and ABV (0–100%).'); return false;
  }

  let presetId = null;
  if ($('#saveAsPreset').checked) {
    if (!name) { alert('Enter a name before saving as a type.'); return false; }
    const preset = addPreset({ name, volumeMl, abv, kcalPer100ml, upc });
    presetId = preset.id;
  }

  logDrink(addModalPersonIdx, {
    name: name || `${fmt(volumeMl,0)} ml · ${fmt(abv,1)}%`,
    volumeMl,
    abv,
    presetId,
  });
  closeModal();
  return true;
}

// --- Presets modal ---------------------------------------------------------
export function openPresetsModal() {
  renderPresetList();
  $('#newPresetName').value = '';
  $('#newPresetVolume').value = '';
  $('#newPresetAbv').value = '';
  $('#presetsModal').classList.add('open');
}

function renderPresetList() {
  const list = $('#presetList');
  list.innerHTML = '';
  state.presets.forEach(preset => {
    const row = document.createElement('div');
    row.className = 'preset-list-item' + (preset.id === state.benchmarkPresetId ? ' active' : '');
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(preset.name)}</div>
        <div class="meta">${fmt(preset.volumeMl,0)} ml · ${fmt(preset.abv,1)}% · ${fmt(ethanolOf(preset),1)} ml ethanol</div>
      </div>
      <button class="star-btn" title="Set as benchmark" data-star="${preset.id}" aria-label="Set as benchmark">★</button>
      <button class="x-btn" title="Delete" data-del-preset="${preset.id}" aria-label="Delete">×</button>
    `;
    list.appendChild(row);
  });
  $$('[data-star]', list).forEach(btn => {
    btn.addEventListener('click', e => { setBenchmark(e.currentTarget.dataset.star); renderPresetList(); render(); });
  });
  $$('[data-del-preset]', list).forEach(btn => {
    btn.addEventListener('click', e => {
      const ok = removePreset(e.currentTarget.dataset.delPreset);
      if (!ok) alert('Keep at least one drink type.');
      else { renderPresetList(); render(); }
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

// --- Shared ---------------------------------------------------------------
export function closeModal() {
  $$('.modal-overlay').forEach(m => m.classList.remove('open'));
}

// Expose the preview updater for app.js input wiring.
export { updateEthanolPreview };
