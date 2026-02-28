/**
 * reduction_plan.js — Carbon Reduction Plan page
 *
 * Manages measures (list + drag-drop), vertical timeline (2024-2050),
 * and scenario save/load for the active saved building.
 */
'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const SESSION_KEY  = 'll97_calc_state';
const YEARS        = Array.from({length: 27}, (_, i) => 2024 + i); // 2024-2050

// Fuel keys → {label, unit, sessionKey}
const FUEL_META = {
  elec_savings:  {label: 'Electricity',  unit: 'kWh',    baseKey: 'elec'},
  gas_savings:   {label: 'Natural Gas',  unit: 'therms', baseKey: 'gas'},
  steam_savings: {label: 'Steam',        unit: 'mLbs',   baseKey: 'steam'},
  oil2_savings:  {label: 'Oil #2',       unit: 'gal',    baseKey: 'fo2'},
  oil4_savings:  {label: 'Oil #4',       unit: 'gal',    baseKey: 'fo4'},
};

// ── State ────────────────────────────────────────────────────────────────────

let currentBuilding   = '';
let measures          = [];   // [{id, name, cost, elec_savings, ...}]
let scenarios         = [];   // [{id, name, number}]
let currentScenarioId = null;
// placements: year (number) → [measureId, ...]
let placements        = {};
// Baseline energy usage from sessionStorage (may be null if not loaded)
let baselineEnergy    = null; // {elec, gas, steam, fo2, fo4} — all numbers

// Warning modal promise resolver
let _warnResolve = null;

// Track which measure card is currently being edited (id or null)
let editingMeasureId  = null;

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) { showNoBuilding(); return; }
    const state = JSON.parse(raw);
    if (!state.saveName) { showNoBuilding(); return; }
    currentBuilding = state.saveName;

    // Load baseline energy usage for savings validation
    if (state.form) {
      baselineEnergy = {
        elec:  parseFloat(state.form.elec)  || 0,
        gas:   parseFloat(state.form.gas)   || 0,
        steam: parseFloat(state.form.steam) || 0,
        fo2:   parseFloat(state.form.fo2)   || 0,
        fo4:   parseFloat(state.form.fo4)   || 0,
      };
    }
  } catch (e) {
    showNoBuilding();
    return;
  }

  try {
    await Promise.all([loadMeasures(), loadScenarios()]);
    buildTimeline();
    bindEventListeners();
    hideLoading();
    showMain();
  } catch (e) {
    showError('Failed to load Reduction Plan data: ' + e.message);
  }
});

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadMeasures() {
  const resp = await fetch(`/api/measures?building=${encodeURIComponent(currentBuilding)}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to load measures');
  measures = data.measures || [];
}

async function loadScenarios() {
  const resp = await fetch(`/api/scenarios?building=${encodeURIComponent(currentBuilding)}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to load scenarios');
  scenarios = data.scenarios || [];

  // Auto-create Scenario 1 if none exist
  if (!scenarios.length) {
    const saveResp = await fetch('/api/scenarios/save', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({building_save_name: currentBuilding, placements: []}),
    });
    const saveData = await saveResp.json();
    scenarios = [saveData.scenario];
  }

  // Populate selector
  const sel = document.getElementById('rp-scenario-select');
  sel.innerHTML = '';
  scenarios.forEach(s => {
    const opt     = document.createElement('option');
    opt.value     = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  currentScenarioId = scenarios[0].id;
  sel.value = currentScenarioId;

  // Load current scenario's placements
  await loadScenarioPlacements(currentScenarioId);
}

async function loadScenarioPlacements(scenarioId) {
  const resp = await fetch(`/api/scenarios/${scenarioId}`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to load scenario');

  placements = {};
  (data.placements || []).forEach(p => {
    if (!placements[p.year]) placements[p.year] = [];
    if (!placements[p.year].includes(p.measure_id)) {
      placements[p.year].push(p.measure_id);
    }
  });
}

// ── Build UI ──────────────────────────────────────────────────────────────────

function buildTimeline() {
  const container = document.getElementById('rp-timeline');
  container.innerHTML = '';
  YEARS.forEach(year => {
    const row      = document.createElement('div');
    row.className  = 'rp-timeline-row';
    row.dataset.year = year;

    const badge    = document.createElement('div');
    badge.className = 'rp-year-badge';
    badge.textContent = year;

    const zone     = document.createElement('div');
    zone.className = 'rp-drop-zone';
    zone.dataset.year = year;

    const hint     = document.createElement('span');
    hint.className = 'rp-drop-hint';
    hint.textContent = 'Drop here';
    zone.appendChild(hint);

    row.appendChild(badge);
    row.appendChild(zone);
    container.appendChild(row);

    // Drop-zone events
    zone.addEventListener('dragover', onDragOver);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('drop', e => onDrop(e, year));
  });

  renderMeasuresList();
  renderAllTimelineYears();
  updateSummaryTable();
}

function renderMeasuresList() {
  const list    = document.getElementById('rp-measures-list');
  const empty   = document.getElementById('rp-measures-empty');
  // Remove old measure cards (preserve empty hint)
  list.querySelectorAll('.rp-measure-card, .rp-edit-form').forEach(el => el.remove());

  if (!measures.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const placed = getPlacedIds();
  measures.forEach(m => {
    if (editingMeasureId === m.id) {
      list.appendChild(makeEditForm(m));
    } else {
      list.appendChild(makeMeasureCard(m, placed.has(m.id)));
    }
  });
}

// ── Warning flags ─────────────────────────────────────────────────────────────

function getExceededFuels(m) {
  if (!baselineEnergy) return [];
  const exceeded = [];
  Object.entries(FUEL_META).forEach(([key, meta]) => {
    const savings = parseFloat(m[key]) || 0;
    const baseline = baselineEnergy[meta.baseKey] || 0;
    if (savings > 0 && baseline > 0 && savings > baseline) {
      exceeded.push({label: meta.label, unit: meta.unit, savings, baseline});
    }
  });
  return exceeded;
}

function makeMeasureCard(m, isPlaced) {
  const card      = document.createElement('div');
  card.className  = 'rp-measure-card' + (isPlaced ? ' rp-measure-placed' : '');
  card.dataset.id = m.id;
  card.draggable  = !isPlaced;

  const exceeded = getExceededFuels(m);

  const info      = document.createElement('div');
  info.className  = 'rp-measure-info';

  const nameRow   = document.createElement('div');
  nameRow.className = 'rp-measure-name-row';

  const name      = document.createElement('span');
  name.className  = 'rp-measure-name';
  name.textContent = m.name;
  nameRow.appendChild(name);

  // Warning flag badge if savings exceed baseline
  if (exceeded.length) {
    const flag    = document.createElement('span');
    flag.className = 'rp-measure-warn-flag';
    flag.title    = 'Savings exceed baseline usage for: ' +
                    exceeded.map(f => f.label).join(', ');
    flag.textContent = '\u26a0 Exceeds Baseline';
    nameRow.appendChild(flag);
  }

  const meta      = document.createElement('div');
  meta.className  = 'rp-measure-meta';
  const parts     = [];
  if (m.cost)          parts.push('$' + Number(m.cost).toLocaleString('en-US'));
  if (m.elec_savings)  parts.push(fmtNum(m.elec_savings) + ' kWh');
  if (m.gas_savings)   parts.push(fmtNum(m.gas_savings) + ' therms');
  if (m.steam_savings) parts.push(fmtNum(m.steam_savings) + ' mLbs');
  if (m.oil2_savings)  parts.push(fmtNum(m.oil2_savings) + ' gal #2');
  if (m.oil4_savings)  parts.push(fmtNum(m.oil4_savings) + ' gal #4');
  meta.textContent = parts.join(' · ') || 'No savings entered';

  info.appendChild(nameRow);
  if (exceeded.length) {
    const note  = document.createElement('div');
    note.className = 'rp-measure-warn-note';
    note.textContent = 'Note: ' + exceeded.map(f =>
      `${f.label} savings (${fmtNum(f.savings)} ${f.unit}) exceed baseline usage (${fmtNum(f.baseline)} ${f.unit})`
    ).join('; ');
    info.appendChild(note);
  }
  info.appendChild(meta);
  card.appendChild(info);

  // Delete button
  const del      = document.createElement('button');
  del.className  = 'rp-measure-delete';
  del.title      = 'Delete measure';
  del.innerHTML  = '&times;';
  del.addEventListener('click', e => { e.stopPropagation(); deleteMeasure(m.id); });
  card.appendChild(del);

  // Click card body (not delete) → open inline edit
  info.addEventListener('click', () => {
    editingMeasureId = m.id;
    renderMeasuresList();
  });

  if (!isPlaced) {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/rp-measure-id', m.id);
      e.dataTransfer.setData('application/rp-drag-type', 'from-list');
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  }

  return card;
}

// ── Inline edit form ──────────────────────────────────────────────────────────

function makeEditForm(m) {
  const wrap = document.createElement('div');
  wrap.className = 'rp-edit-form';
  wrap.dataset.id = m.id;

  wrap.innerHTML = `
    <div class="rp-edit-title">Edit Measure</div>
    <div class="rp-edit-grid">
      <div class="input-group rp-edit-full">
        <label class="input-label">Measure Name <span class="req-star">*</span></label>
        <input type="text" id="rp-edit-name" class="form-input" value="${escHtml(m.name)}" />
      </div>
      <div class="input-group">
        <label class="input-label">Cost <span class="unit">($)</span></label>
        <input type="number" id="rp-edit-cost" class="form-input" min="0" value="${m.cost || ''}" />
      </div>
      <div class="input-group">
        <label class="input-label">Electricity Savings <span class="unit">(kWh)</span></label>
        <input type="number" id="rp-edit-elec" class="form-input" value="${m.elec_savings || ''}" data-fuel="elec_savings" />
      </div>
      <div class="input-group">
        <label class="input-label">Natural Gas Savings <span class="unit">(therms)</span></label>
        <input type="number" id="rp-edit-gas" class="form-input" value="${m.gas_savings || ''}" data-fuel="gas_savings" />
      </div>
      <div class="input-group">
        <label class="input-label">Steam Savings <span class="unit">(mLbs)</span></label>
        <input type="number" id="rp-edit-steam" class="form-input" value="${m.steam_savings || ''}" data-fuel="steam_savings" />
      </div>
      <div class="input-group">
        <label class="input-label">Oil #2 Savings <span class="unit">(gal)</span></label>
        <input type="number" id="rp-edit-oil2" class="form-input" value="${m.oil2_savings || ''}" data-fuel="oil2_savings" />
      </div>
      <div class="input-group">
        <label class="input-label">Oil #4 Savings <span class="unit">(gal)</span></label>
        <input type="number" id="rp-edit-oil4" class="form-input" value="${m.oil4_savings || ''}" data-fuel="oil4_savings" />
      </div>
    </div>
    <div class="rp-edit-actions">
      <button id="rp-edit-save" class="btn btn-primary btn-sm">Save Changes</button>
      <button id="rp-edit-cancel" class="btn btn-secondary btn-sm">Cancel</button>
      <span id="rp-edit-error" class="rp-inline-error hidden"></span>
    </div>
  `;

  // Bind savings validation on blur
  wrap.querySelectorAll('[data-fuel]').forEach(input => {
    input.addEventListener('blur', () => checkSavingsField(input));
  });

  wrap.querySelector('#rp-edit-save').addEventListener('click', () => saveMeasureEdit(m.id));
  wrap.querySelector('#rp-edit-cancel').addEventListener('click', () => {
    editingMeasureId = null;
    renderMeasuresList();
  });

  return wrap;
}

async function saveMeasureEdit(id) {
  const errEl = document.getElementById('rp-edit-error');
  const name  = (document.getElementById('rp-edit-name').value || '').trim();
  if (!name) {
    errEl.textContent = 'Measure Name is required.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const body = {
    name,
    cost:          parseFloat(document.getElementById('rp-edit-cost').value)  || 0,
    elec_savings:  parseFloat(document.getElementById('rp-edit-elec').value)  || 0,
    gas_savings:   parseFloat(document.getElementById('rp-edit-gas').value)   || 0,
    steam_savings: parseFloat(document.getElementById('rp-edit-steam').value) || 0,
    oil2_savings:  parseFloat(document.getElementById('rp-edit-oil2').value)  || 0,
    oil4_savings:  parseFloat(document.getElementById('rp-edit-oil4').value)  || 0,
  };

  // Check for exceeded savings — ask user to confirm
  const confirmed = await validateSavingsObj(body);
  if (!confirmed) return;

  try {
    const resp = await fetch(`/api/measures/${id}`, {
      method:  'PUT',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');
    // Update local store
    const idx = measures.findIndex(m => m.id === id);
    if (idx !== -1) measures[idx] = data.measure;
    editingMeasureId = null;
    renderMeasuresList();
    showToast('Measure updated');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Savings validation ────────────────────────────────────────────────────────

/**
 * Check a single savings input field on blur.
 * If it exceeds baseline, show warning modal. On No, clear the field.
 */
async function checkSavingsField(input) {
  if (!baselineEnergy) return;
  const fuelKey = input.dataset.fuel;
  const meta    = FUEL_META[fuelKey];
  if (!meta) return;
  const val     = parseFloat(input.value) || 0;
  const base    = baselineEnergy[meta.baseKey] || 0;
  if (val > 0 && base > 0 && val > base) {
    const ok = await showWarnModal([{label: meta.label, unit: meta.unit, savings: val, baseline: base}]);
    if (!ok) input.value = '';
  }
}

/**
 * Validate a savings object before saving.
 * Returns true if user confirms (or no exceedances), false otherwise.
 */
async function validateSavingsObj(body) {
  if (!baselineEnergy) return true;
  const exceeded = [];
  Object.entries(FUEL_META).forEach(([key, meta]) => {
    const val  = parseFloat(body[key]) || 0;
    const base = baselineEnergy[meta.baseKey] || 0;
    if (val > 0 && base > 0 && val > base) {
      exceeded.push({label: meta.label, unit: meta.unit, savings: val, baseline: base});
    }
  });
  if (!exceeded.length) return true;
  return showWarnModal(exceeded);
}

/**
 * Show the warning modal. Returns a promise that resolves true (Yes) or false (No).
 */
function showWarnModal(exceeded) {
  return new Promise(resolve => {
    _warnResolve = resolve;

    const title = document.getElementById('rp-warn-title');
    const body  = document.getElementById('rp-warn-body');

    if (title) title.textContent = 'Savings Exceeds Baseline Usage — Are you sure?';
    if (body) {
      body.innerHTML = exceeded.map(f =>
        `<div class="rp-warn-usage">` +
        `<strong>${escHtml(f.label)}:</strong> ` +
        `Savings entered: <strong>${fmtNum(f.savings)} ${f.unit}</strong> &nbsp;|&nbsp; ` +
        `Baseline usage: <strong>${fmtNum(f.baseline)} ${f.unit}</strong>` +
        `</div>`
      ).join('');
    }

    const backdrop = document.getElementById('rp-warn-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');
  });
}

// ── Timeline UI ───────────────────────────────────────────────────────────────

function renderAllTimelineYears() {
  YEARS.forEach(year => renderTimelineYear(year));
}

function renderTimelineYear(year) {
  const zone   = document.querySelector(`.rp-drop-zone[data-year="${year}"]`);
  if (!zone) return;
  // Remove existing chips
  zone.querySelectorAll('.rp-placed-chip').forEach(el => el.remove());

  const hint   = zone.querySelector('.rp-drop-hint');
  const ids    = placements[year] || [];

  if (ids.length) {
    hint.classList.add('hidden');
    zone.classList.add('has-items');
  } else {
    hint.classList.remove('hidden');
    zone.classList.remove('has-items');
    return;
  }

  ids.forEach(mid => {
    const m = measures.find(x => x.id === mid);
    if (!m) return;

    const chip     = document.createElement('div');
    chip.className = 'rp-placed-chip';
    chip.dataset.id = mid;
    chip.draggable  = true;

    const label    = document.createElement('span');
    label.textContent = m.name;
    chip.appendChild(label);

    const rem      = document.createElement('button');
    rem.className  = 'rp-chip-remove';
    rem.innerHTML  = '&times;';
    rem.title      = 'Remove from timeline';
    rem.addEventListener('click', e => {
      e.stopPropagation();
      removePlacement(year, mid);
    });
    chip.appendChild(rem);

    // Allow dragging from timeline to another year
    chip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/rp-measure-id', mid);
      e.dataTransfer.setData('application/rp-drag-type', 'from-timeline');
      e.dataTransfer.setData('application/rp-source-year', year);
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));

    zone.appendChild(chip);
  });
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}

function onDragLeave() {
  this.classList.remove('drag-over');
}

function onDrop(e, targetYear) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');

  const measureId  = parseInt(e.dataTransfer.getData('application/rp-measure-id'), 10);
  const dragType   = e.dataTransfer.getData('application/rp-drag-type');
  const sourceYear = dragType === 'from-timeline'
    ? parseInt(e.dataTransfer.getData('application/rp-source-year'), 10)
    : null;

  if (!measureId) return;

  // If moving from another year, remove from source first
  if (sourceYear && sourceYear !== targetYear) {
    const srcIds = placements[sourceYear] || [];
    placements[sourceYear] = srcIds.filter(id => id !== measureId);
    renderTimelineYear(sourceYear);
  } else if (!sourceYear) {
    // Dragging from list: check it's not already placed
    if (getPlacedIds().has(measureId)) return;
  } else {
    // Dropped back on same year — no-op
    return;
  }

  if (!placements[targetYear]) placements[targetYear] = [];
  if (!placements[targetYear].includes(measureId)) {
    placements[targetYear].push(measureId);
  }

  renderTimelineYear(targetYear);
  renderMeasuresList();
  updateSummaryTable();
}

function removePlacement(year, measureId) {
  const ids = placements[year] || [];
  placements[year] = ids.filter(id => id !== measureId);
  renderTimelineYear(year);
  renderMeasuresList();
  updateSummaryTable();
}

function getPlacedIds() {
  const set = new Set();
  Object.values(placements).forEach(ids => ids.forEach(id => set.add(id)));
  return set;
}

// ── Summary table ─────────────────────────────────────────────────────────────

function updateSummaryTable() {
  const section = document.getElementById('rp-summary-section');
  const tbody   = document.getElementById('rp-summary-tbody');
  const tfoot   = document.getElementById('rp-summary-tfoot');

  const activeYears = YEARS.filter(y => (placements[y] || []).length > 0);
  if (!activeYears.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  tbody.innerHTML = '';
  const totals = {cost: 0, elec: 0, gas: 0, steam: 0, oil2: 0, oil4: 0};

  activeYears.forEach(year => {
    const ids = placements[year] || [];
    const ms  = ids.map(id => measures.find(m => m.id === id)).filter(Boolean);

    const yr = {cost: 0, elec: 0, gas: 0, steam: 0, oil2: 0, oil4: 0};
    ms.forEach(m => {
      yr.cost  += m.cost  || 0;
      yr.elec  += m.elec_savings  || 0;
      yr.gas   += m.gas_savings   || 0;
      yr.steam += m.steam_savings || 0;
      yr.oil2  += m.oil2_savings  || 0;
      yr.oil4  += m.oil4_savings  || 0;
    });
    Object.keys(totals).forEach(k => totals[k] += yr[k]);

    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="rp-sum-year">${year}</td>` +
      `<td class="rp-sum-names">${ms.map(m => escHtml(m.name)).join(', ')}</td>` +
      `<td class="rp-sum-cost">${yr.cost ? '$' + yr.cost.toLocaleString('en-US') : '—'}</td>` +
      `<td class="${yr.elec < 0 ? 'neg' : ''}">${yr.elec ? fmtNum(yr.elec) : '—'}</td>` +
      `<td class="${yr.gas < 0 ? 'neg' : ''}">${yr.gas ? fmtNum(yr.gas) : '—'}</td>` +
      `<td class="${yr.steam < 0 ? 'neg' : ''}">${yr.steam ? fmtNum(yr.steam) : '—'}</td>` +
      `<td class="${yr.oil2 < 0 ? 'neg' : ''}">${yr.oil2 ? fmtNum(yr.oil2) : '—'}</td>` +
      `<td class="${yr.oil4 < 0 ? 'neg' : ''}">${yr.oil4 ? fmtNum(yr.oil4) : '—'}</td>`;
    tbody.appendChild(tr);
  });

  tfoot.innerHTML =
    `<tr class="rp-sum-total">` +
    `<td colspan="2">Total</td>` +
    `<td>${totals.cost ? '<strong>$' + totals.cost.toLocaleString('en-US') + '</strong>' : '—'}</td>` +
    `<td>${totals.elec  ? fmtNum(totals.elec)  : '—'}</td>` +
    `<td>${totals.gas   ? fmtNum(totals.gas)   : '—'}</td>` +
    `<td>${totals.steam ? fmtNum(totals.steam) : '—'}</td>` +
    `<td>${totals.oil2  ? fmtNum(totals.oil2)  : '—'}</td>` +
    `<td>${totals.oil4  ? fmtNum(totals.oil4)  : '—'}</td>` +
    `</tr>`;
}

// ── Measure CRUD ──────────────────────────────────────────────────────────────

async function addMeasure() {
  const nameEl  = document.getElementById('rp-name');
  const errEl   = document.getElementById('rp-add-error');
  const name    = nameEl.value.trim();
  if (!name) {
    errEl.textContent = 'Measure Name is required.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  const body = {
    building_save_name: currentBuilding,
    name,
    cost:          parseFloat(document.getElementById('rp-cost').value)  || 0,
    elec_savings:  parseFloat(document.getElementById('rp-elec').value)  || 0,
    gas_savings:   parseFloat(document.getElementById('rp-gas').value)   || 0,
    steam_savings: parseFloat(document.getElementById('rp-steam').value) || 0,
    oil2_savings:  parseFloat(document.getElementById('rp-oil2').value)  || 0,
    oil4_savings:  parseFloat(document.getElementById('rp-oil4').value)  || 0,
  };

  // Check for exceeded savings — ask user to confirm
  const confirmed = await validateSavingsObj(body);
  if (!confirmed) return;

  try {
    const resp = await fetch('/api/measures', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');
    measures.push(data.measure);
    clearAddForm();
    document.getElementById('rp-add-form').classList.add('hidden');
    renderMeasuresList();
    showToast('Measure added');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

async function deleteMeasure(id) {
  if (!confirm('Delete this measure? It will be removed from all scenarios.')) return;

  // Remove from placements in current view
  Object.keys(placements).forEach(yr => {
    placements[yr] = placements[yr].filter(mid => mid !== id);
  });
  if (editingMeasureId === id) editingMeasureId = null;

  try {
    await fetch(`/api/measures/${id}`, {method: 'DELETE'});
    measures = measures.filter(m => m.id !== id);
    renderAllTimelineYears();
    renderMeasuresList();
    updateSummaryTable();
    showToast('Measure deleted');
  } catch (e) {
    showError('Failed to delete measure: ' + e.message);
  }
}

// ── File upload ───────────────────────────────────────────────────────────────

async function handleUpload(file) {
  const statusEl = document.getElementById('rp-upload-status');
  statusEl.className  = 'rp-upload-status';
  statusEl.textContent = 'Uploading…';
  statusEl.classList.remove('hidden');

  const fd = new FormData();
  fd.append('file', file);
  fd.append('building_save_name', currentBuilding);

  try {
    const resp = await fetch('/api/upload-measures', {method: 'POST', body: fd});
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Upload failed');

    measures.push(...data.created);
    renderMeasuresList();

    let msg = `${data.created.length} measure(s) imported.`;
    if (data.errors && data.errors.length) {
      msg += ' Skipped: ' + data.errors.join('; ');
      statusEl.classList.add('rp-upload-warn');
    } else {
      statusEl.classList.add('rp-upload-ok');
    }
    statusEl.textContent = msg;
    showToast(msg.split('.')[0]);
  } catch (e) {
    statusEl.classList.add('rp-upload-error');
    statusEl.textContent = 'Upload failed: ' + e.message;
  }
}

// ── Scenario save ─────────────────────────────────────────────────────────────

function buildPlacementsPayload() {
  const arr = [];
  Object.entries(placements).forEach(([yr, ids]) => {
    ids.forEach(mid => arr.push({measure_id: mid, year: parseInt(yr, 10)}));
  });
  return arr;
}

async function saveScenario(asNew) {
  const statusEl = document.getElementById('rp-save-status');
  statusEl.textContent = '';
  statusEl.className   = 'rp-save-status';

  const body = {
    placements: buildPlacementsPayload(),
  };
  if (asNew) {
    body.building_save_name = currentBuilding;
    // no scenario_id → server creates new
  } else {
    body.scenario_id = currentScenarioId;
  }

  try {
    const resp = await fetch('/api/scenarios/save', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Save failed');

    if (asNew) {
      // Add new scenario to list & select it
      scenarios.push(data.scenario);
      const sel = document.getElementById('rp-scenario-select');
      const opt = document.createElement('option');
      opt.value = data.scenario.id;
      opt.textContent = data.scenario.name;
      sel.appendChild(opt);
      currentScenarioId = data.scenario.id;
      sel.value = currentScenarioId;
    }

    statusEl.textContent = 'Saved \u2713';
    statusEl.classList.add('rp-save-ok');
    showToast(asNew ? `${data.scenario.name} saved` : 'Scenario saved');
  } catch (e) {
    statusEl.textContent = 'Save failed';
    statusEl.classList.add('rp-save-error');
    showError('Save failed: ' + e.message);
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

function bindEventListeners() {
  // Scenario selector
  document.getElementById('rp-scenario-select').addEventListener('change', async function() {
    currentScenarioId = parseInt(this.value, 10);
    await loadScenarioPlacements(currentScenarioId);
    renderAllTimelineYears();
    renderMeasuresList();
    updateSummaryTable();
  });

  // Save button
  document.getElementById('rp-save-btn').addEventListener('click', () => saveScenario(false));

  // Save dropdown toggle
  document.getElementById('rp-save-dropdown-btn').addEventListener('click', () => {
    document.getElementById('rp-save-dropdown').classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.rp-save-group')) {
      document.getElementById('rp-save-dropdown').classList.add('hidden');
    }
  });

  // Save As New
  document.getElementById('rp-save-new-btn').addEventListener('click', () => {
    document.getElementById('rp-save-dropdown').classList.add('hidden');
    saveScenario(true);
  });

  // Add measure toggle
  document.getElementById('rp-add-toggle').addEventListener('click', () => {
    document.getElementById('rp-add-form').classList.toggle('hidden');
  });
  document.getElementById('rp-add-confirm').addEventListener('click', addMeasure);
  document.getElementById('rp-add-cancel').addEventListener('click', () => {
    clearAddForm();
    document.getElementById('rp-add-form').classList.add('hidden');
  });
  document.getElementById('rp-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') addMeasure();
  });

  // Savings validation on blur for add form
  ['rp-elec', 'rp-gas', 'rp-steam', 'rp-oil2', 'rp-oil4'].forEach((id, i) => {
    const fuelKey = ['elec_savings', 'gas_savings', 'steam_savings', 'oil2_savings', 'oil4_savings'][i];
    const input = document.getElementById(id);
    if (input) {
      input.dataset.fuel = fuelKey;
      input.addEventListener('blur', () => checkSavingsField(input));
    }
  });

  // File upload
  document.getElementById('rp-upload-input').addEventListener('change', function() {
    if (this.files && this.files[0]) handleUpload(this.files[0]);
    this.value = '';
  });

  // Warning modal Yes/No
  const warnYes = document.getElementById('rp-warn-yes');
  const warnNo  = document.getElementById('rp-warn-no');
  if (warnYes) {
    warnYes.addEventListener('click', () => {
      document.getElementById('rp-warn-backdrop').classList.add('hidden');
      if (_warnResolve) { _warnResolve(true); _warnResolve = null; }
    });
  }
  if (warnNo) {
    warnNo.addEventListener('click', () => {
      document.getElementById('rp-warn-backdrop').classList.add('hidden');
      if (_warnResolve) { _warnResolve(false); _warnResolve = null; }
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearAddForm() {
  ['rp-name','rp-cost','rp-elec','rp-gas','rp-steam','rp-oil2','rp-oil4']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('rp-add-error').classList.add('hidden');
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US', {maximumFractionDigits: 1});
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'save-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 700); }, 2000);
}

function showNoBuilding() {
  document.getElementById('rp-loading').classList.add('hidden');
  document.getElementById('rp-no-building').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('rp-loading').classList.add('hidden');
}

function showMain() {
  document.getElementById('rp-main').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('rp-loading').classList.add('hidden');
  const el = document.getElementById('rp-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
