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

// Compliance period definitions (used for scenario insight banner)
const PERIOD_DEFS = [
  {key: '2024_2029', startYear: 2024, years: 6,  label: '2024–2029'},
  {key: '2030_2034', startYear: 2030, years: 5,  label: '2030–2034'},
  {key: '2035_2039', startYear: 2035, years: 5,  label: '2035–2039'},
  {key: '2040_2049', startYear: 2040, years: 10, label: '2040–2049'},
  {key: '2050_plus', startYear: 2050, years: 1,  label: '2050+'},
];

// Maps each year 2024-2050 → compliance period key
const PERIOD_FOR_YEAR = {};
[['2024_2029',[2024,2025,2026,2027,2028,2029]],
 ['2030_2034',[2030,2031,2032,2033,2034]],
 ['2035_2039',[2035,2036,2037,2038,2039]],
 ['2040_2049',[2040,2041,2042,2043,2044,2045,2046,2047,2048,2049]],
 ['2050_plus',[2050]]].forEach(([p, yrs]) => yrs.forEach(y => PERIOD_FOR_YEAR[y] = p));

// Savings baseKey → {priceKey (for settings/prices), efKey (for settings/current), kbtu}
const FUEL_COST_MAP = {
  elec:  {priceKey: 'electricity_kwh',    efKey: 'electricity_kwh',     kbtu: 1},
  gas:   {priceKey: 'natural_gas_therm',  efKey: 'natural_gas_kbtu',    kbtu: 100},
  steam: {priceKey: 'district_steam_mlb', efKey: 'district_steam_kbtu', kbtu: 1194},
  fo2:   {priceKey: 'fuel_oil_2_gal',     efKey: 'fuel_oil_2_kbtu',     kbtu: 138.5},
  fo4:   {priceKey: 'fuel_oil_4_gal',     efKey: 'fuel_oil_4_kbtu',     kbtu: 146.0},
};

// ── State ────────────────────────────────────────────────────────────────────

let currentBuilding      = '';
let measures             = [];   // [{id, name, cost, elec_savings, ...}]
let scenarios            = [];   // [{id, name, number}]
let currentScenarioId    = null;
let selectedScenarioId   = null; // The "starred" scenario for this building
// placements: year (number) → [measureId, ...]
let placements           = {};
// Baseline energy usage from localStorage (may be null if not loaded)
let baselineEnergy       = null; // {elec, gas, steam, fo2, fo4} — all numbers

// Warning modal promise resolver
let _warnResolve = null;

// Pending navigation (used by unsaved-changes modal)
let _pendingNavHref       = null;
let _pendingNavIsTimeline = false;

// Track which measure card is currently being edited (id or null)
let editingMeasureId  = null;
let isDirty           = false;       // unsaved timeline changes
let baselineOccupancyGroups = null;  // occupancy groups from session state

// Prices/emission factors for cost & carbon savings columns
let pricesCfg      = null; // {electricity_kwh: {price, escalator}, natural_gas_therm: {...}, ...}
let utilFactors    = null; // {2024_2029: {electricity_kwh: N, natural_gas_kbtu: N, ...}, ...}
let baselineResults = null; // {2024_2029: {emissions, limit, compliant, penalty}, ...} from /api/calculate

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) { showNoBuilding(); return; }
    const state = JSON.parse(raw);
    if (!state.saveName) { showNoBuilding(); return; }
    currentBuilding = state.saveName;

    // Load baseline energy usage and occupancy for savings validation + suggest plan
    if (state.form) {
      baselineEnergy = {
        elec:  parseFloat(state.form.elec)  || 0,
        gas:   parseFloat(state.form.gas)   || 0,
        steam: parseFloat(state.form.steam) || 0,
        fo2:   parseFloat(state.form.fo2)   || 0,
        fo4:   parseFloat(state.form.fo4)   || 0,
      };
    }
    if (state.occRows) {
      baselineOccupancyGroups = (state.occRows || [])
        .map(r => ({property_type: r.type, floor_area: parseFloat(r.area) || 0}))
        .filter(g => g.property_type && g.floor_area > 0);
    }
  } catch (e) {
    showNoBuilding();
    return;
  }

  try {
    await Promise.all([loadMeasures(), loadScenarios(), loadPricesAndFactors(), loadBaselineCompliance()]);
    buildTimeline();
    bindEventListeners();
    updateSuggestBtn();
    window.addEventListener('beforeunload', e => {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    });
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
  selectedScenarioId = data.selected_scenario_id || null;

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
    opt.textContent = s.name + (s.is_selected ? ' ★' : '');
    sel.appendChild(opt);
  });

  // Check if Timeline passed a scenario to pre-select
  currentScenarioId = scenarios[0].id;
  const timelineScenId = localStorage.getItem('ll97_timeline_scenario_id');
  if (timelineScenId) {
    localStorage.removeItem('ll97_timeline_scenario_id');
    const targetId = parseInt(timelineScenId, 10);
    if (scenarios.some(s => s.id === targetId)) currentScenarioId = targetId;
  }
  sel.value = currentScenarioId;

  updateStarButton();

  // Load current scenario's placements
  await loadScenarioPlacements(currentScenarioId);
}

function updateStarButton() {
  const btn = document.getElementById('rp-star-btn');
  if (!btn) return;
  const isSelected = (currentScenarioId === selectedScenarioId);
  btn.innerHTML = isSelected ? '&#9733;' : '&#9734;';
  btn.title = isSelected
    ? 'This is the Selected Scenario — click to unstar'
    : 'Mark as Selected Scenario for this building';
  btn.classList.toggle('rp-star-active', isSelected);
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
  markClean();
}

async function loadPricesAndFactors() {
  try {
    const [pr, ef] = await Promise.all([
      fetch('/api/settings/prices').then(r => r.json()),
      fetch('/api/settings/current').then(r => r.json()),
    ]);
    pricesCfg   = pr.prices   || {};
    utilFactors = ef.current  || {};
  } catch (_) {
    // Non-fatal: cost/carbon savings columns will show '—'
  }
}

async function loadBaselineCompliance() {
  if (!baselineEnergy || !baselineOccupancyGroups || !baselineOccupancyGroups.length) return;
  try {
    const resp = await fetch('/api/calculate', {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({
        electricity_kwh:    baselineEnergy.elec,
        natural_gas_therms: baselineEnergy.gas,
        district_steam_mlb: baselineEnergy.steam,
        fuel_oil_2_gal:     baselineEnergy.fo2,
        fuel_oil_4_gal:     baselineEnergy.fo4,
        occupancy_groups:   baselineOccupancyGroups,
      }),
    });
    const data = await resp.json();
    if (resp.ok) baselineResults = data.results;
  } catch (_) { /* non-critical — insight banner simply won't show */ }
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

  // Drop onto the measures panel → remove from timeline
  const measuresList = document.getElementById('rp-measures-list');
  measuresList.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('application/rp-drag-type')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    measuresList.classList.add('drag-target');
  });
  measuresList.addEventListener('dragleave', e => {
    if (!measuresList.contains(e.relatedTarget)) measuresList.classList.remove('drag-target');
  });
  measuresList.addEventListener('drop', e => {
    e.preventDefault();
    measuresList.classList.remove('drag-target');
    if (e.dataTransfer.getData('application/rp-drag-type') !== 'from-timeline') return;
    const measureId  = parseInt(e.dataTransfer.getData('application/rp-measure-id'), 10);
    const sourceYear = parseInt(e.dataTransfer.getData('application/rp-source-year'), 10);
    if (measureId && sourceYear) removePlacement(sourceYear, measureId);
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

function getUnusedFuelSavings(m) {
  if (!baselineEnergy) return [];
  const unused = [];
  Object.entries(FUEL_META).forEach(([key, meta]) => {
    const savings = parseFloat(m[key]) || 0;
    const baseline = baselineEnergy[meta.baseKey] || 0;
    // Only flag positive savings on a fuel with no baseline usage
    if (savings > 0 && baseline === 0) {
      unused.push({label: meta.label, unit: meta.unit, savings});
    }
  });
  return unused;
}

function hasMissingCost(m) {
  return !(m.cost > 0);
}

function makeMeasureCard(m, isPlaced) {
  const card      = document.createElement('div');
  card.className  = 'rp-measure-card' + (isPlaced ? ' rp-measure-placed' : '');
  card.dataset.id = m.id;
  card.draggable  = !isPlaced;

  const exceeded  = getExceededFuels(m);
  const unusedFuels = getUnusedFuelSavings(m);
  const missingCost = hasMissingCost(m);

  const info      = document.createElement('div');
  info.className  = 'rp-measure-info';

  const nameRow   = document.createElement('div');
  nameRow.className = 'rp-measure-name-row';

  const name      = document.createElement('span');
  name.className  = 'rp-measure-name';
  name.textContent = m.name;
  nameRow.appendChild(name);

  // Warning flag — savings exceed baseline
  if (exceeded.length) {
    const flag    = document.createElement('span');
    flag.className = 'rp-measure-warn-flag';
    flag.title    = 'Savings exceed baseline usage for: ' + exceeded.map(f => f.label).join(', ');
    flag.textContent = '\u26a0 Exceeds Baseline';
    nameRow.appendChild(flag);
  }

  // Warning flag — savings on unused fuel
  if (unusedFuels.length) {
    const flag    = document.createElement('span');
    flag.className = 'rp-measure-warn-flag rp-measure-warn-unused';
    flag.title    = 'Building shows no baseline usage for: ' + unusedFuels.map(f => f.label).join(', ');
    flag.textContent = '\u26a0 Unused Fuel';
    nameRow.appendChild(flag);
  }

  // Warning flag — no cost entered
  if (missingCost) {
    const flag    = document.createElement('span');
    flag.className = 'rp-measure-warn-flag rp-measure-warn-nocost';
    flag.title    = 'No capital cost entered for this measure';
    flag.textContent = '\u26a0 No Cost';
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
  // tCO₂e/yr using 2024–2029 emission factors as reference
  if (utilFactors) {
    const ef = utilFactors['2024_2029'] || {};
    const co2 = (m.elec_savings  || 0) * (ef.electricity_kwh     || 0)
              + (m.gas_savings   || 0) * 100   * (ef.natural_gas_kbtu    || 0)
              + (m.steam_savings || 0) * 1194  * (ef.district_steam_kbtu || 0)
              + (m.oil2_savings  || 0) * 138.5 * (ef.fuel_oil_2_kbtu     || 0)
              + (m.oil4_savings  || 0) * 146.0 * (ef.fuel_oil_4_kbtu     || 0);
    if (co2 > 0.005) parts.push(fmtNum(co2) + ' tCO\u2082e/yr');
  }
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
  if (unusedFuels.length) {
    const note  = document.createElement('div');
    note.className = 'rp-measure-warn-note';
    note.textContent = 'Note: Building has no baseline usage for ' + unusedFuels.map(f => f.label).join(', ');
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
    attachTouchDrag(card, m.id, 'from-list', null);
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

  // Bind cost validation on blur
  const editCostInput = wrap.querySelector('#rp-edit-cost');
  if (editCostInput) editCostInput.addEventListener('blur', () => checkCostField(editCostInput));

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

  // Warn if cost is $0
  if (body.cost === 0) {
    const ok = await showNoCostModal();
    if (!ok) return;
  }

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
    renderAllTimelineYears();   // update measure name chips in the timeline
    updateSummaryTable();       // recolor year badges + refresh scenario summary
    showToast('Measure updated');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Savings validation ────────────────────────────────────────────────────────

/**
 * Check a single savings input field on blur.
 * If it exceeds baseline OR uses a fuel with no baseline, show warning modal.
 */
async function checkSavingsField(input) {
  if (!baselineEnergy) return;
  const fuelKey = input.dataset.fuel;
  const meta    = FUEL_META[fuelKey];
  if (!meta) return;
  const val     = parseFloat(input.value) || 0;
  const base    = baselineEnergy[meta.baseKey] || 0;
  if (val > 0 && base === 0) {
    // Unused fuel warning
    const ok = await showWarnModal([{label: meta.label, unit: meta.unit, savings: val, baseline: 0, unusedFuel: true}]);
    if (!ok) input.value = '';
  } else if (val > 0 && base > 0 && val > base) {
    const ok = await showWarnModal([{label: meta.label, unit: meta.unit, savings: val, baseline: base}]);
    if (!ok) input.value = '';
  }
}

/**
 * Check the cost field on blur. If 0, warn the user.
 */
async function checkCostField(input) {
  const val = parseFloat(input.value) || 0;
  if (val === 0) {
    const ok = await showNoCostModal();
    if (!ok) {
      input.focus();
    }
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

    const hasUnused = exceeded.some(f => f.unusedFuel);
    if (title) {
      title.textContent = hasUnused
        ? 'Fuel Not Currently in Use — Are you sure?'
        : 'Savings Exceeds Baseline Usage — Are you sure?';
    }
    if (body) {
      body.innerHTML = exceeded.map(f =>
        f.unusedFuel
          ? `<div class="rp-warn-usage"><strong>${escHtml(f.label)}:</strong> Building shows no baseline usage for this fuel. ` +
            `Savings entered: <strong>${fmtNum(f.savings)} ${f.unit}</strong></div>`
          : `<div class="rp-warn-usage"><strong>${escHtml(f.label)}:</strong> ` +
            `Savings entered: <strong>${fmtNum(f.savings)} ${f.unit}</strong> &nbsp;|&nbsp; ` +
            `Baseline usage: <strong>${fmtNum(f.baseline)} ${f.unit}</strong></div>`
      ).join('');
    }

    const backdrop = document.getElementById('rp-warn-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');
  });
}

/**
 * Show a "no cost" warning. Returns promise resolving true (keep $0) / false (enter a cost).
 */
function showNoCostModal() {
  return new Promise(resolve => {
    _warnResolve = resolve;
    const title = document.getElementById('rp-warn-title');
    const body  = document.getElementById('rp-warn-body');
    const yes   = document.getElementById('rp-warn-yes');
    const no    = document.getElementById('rp-warn-no');
    if (title) title.textContent = 'Measure has no cost — Are you sure?';
    if (body)  body.innerHTML    = '<div class="rp-warn-usage">No capital cost has been entered for this measure. Proceed with $0?</div>';
    if (yes)   yes.textContent   = 'Yes, keep $0';
    if (no)    no.textContent    = 'No, enter a cost';
    const backdrop = document.getElementById('rp-warn-backdrop');
    if (backdrop) backdrop.classList.remove('hidden');
  }).then(result => {
    // Reset button labels after modal closes
    const yes = document.getElementById('rp-warn-yes');
    const no  = document.getElementById('rp-warn-no');
    if (yes) yes.textContent = 'Yes, Keep Value';
    if (no)  no.textContent  = 'No, Clear Field';
    return result;
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
    attachTouchDrag(chip, mid, 'from-timeline', year);

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
  markDirty();
}

function removePlacement(year, measureId) {
  const ids = placements[year] || [];
  placements[year] = ids.filter(id => id !== measureId);
  renderTimelineYear(year);
  renderMeasuresList();
  updateSummaryTable();
  markDirty();
}

function getPlacedIds() {
  const set = new Set();
  Object.values(placements).forEach(ids => ids.forEach(id => set.add(id)));
  return set;
}

// ── Touch drag-and-drop (mobile/Android fallback) ─────────────────────────────
// HTML5 drag-and-drop events don't fire reliably on Android Chrome touch screens.
// This parallel touch implementation mirrors the same drop logic using touch events.

let _tdId = null, _tdType = null, _tdSrc = null;
let _tdClone = null, _tdEl = null;
let _tdStartX = 0, _tdStartY = 0, _tdActive = false;

function attachTouchDrag(el, measureId, dragType, sourceYear) {
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    _tdId = measureId; _tdType = dragType; _tdSrc = sourceYear || null;
    _tdEl = el; _tdStartX = t.clientX; _tdStartY = t.clientY; _tdActive = false;
  }, {passive: true});
}

function _tdStart(el) {
  const rect = el.getBoundingClientRect();
  _tdClone = el.cloneNode(true);
  _tdClone.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;` +
    `pointer-events:none;opacity:.75;z-index:9999;` +
    `transform:scale(1.04);box-shadow:0 4px 16px rgba(0,0,0,.25);transition:none`;
  document.body.appendChild(_tdClone);
  el.classList.add('dragging');
}

function _tdClear() {
  if (_tdClone) { _tdClone.remove(); _tdClone = null; }
  if (_tdEl) { _tdEl.classList.remove('dragging'); }
  document.querySelectorAll('.drag-over, .drag-target')
    .forEach(el => el.classList.remove('drag-over', 'drag-target'));
  _tdId = _tdType = _tdSrc = _tdEl = null; _tdActive = false;
}

function _tdDropToYear(targetYear) {
  if (!_tdId) return;
  if (_tdType === 'from-timeline') {
    if (!_tdSrc || _tdSrc === targetYear) return;
    placements[_tdSrc] = (placements[_tdSrc] || []).filter(id => id !== _tdId);
    renderTimelineYear(_tdSrc);
  } else {
    if (getPlacedIds().has(_tdId)) return;
  }
  if (!placements[targetYear]) placements[targetYear] = [];
  if (!placements[targetYear].includes(_tdId)) placements[targetYear].push(_tdId);
  renderTimelineYear(targetYear);
  renderMeasuresList();
  updateSummaryTable();
  markDirty();
}

// ── Summary table ─────────────────────────────────────────────────────────────

// Compute escalated price for a fuel in a given year (base year = 2024)
function escalatedPrice(priceKey, year) {
  if (!pricesCfg || !pricesCfg[priceKey]) return null;
  const {price, escalator} = pricesCfg[priceKey];
  return price * Math.pow(1 + (escalator || 0) / 100, year - 2024);
}

// Compute annual cost savings for a set of fuel quantities at a given year
function calcCostSavings(yr, year) {
  if (!pricesCfg) return null;
  let total = 0;
  const fuelMap = {elec: 'electricity_kwh', gas: 'natural_gas_therm',
                   steam: 'district_steam_mlb', fo2: 'fuel_oil_2_gal', fo4: 'fuel_oil_4_gal'};
  Object.entries(fuelMap).forEach(([baseKey, priceKey]) => {
    const savings = yr[baseKey === 'elec' ? 'elec' : baseKey === 'gas' ? 'gas' :
                       baseKey === 'steam' ? 'steam' : baseKey === 'fo2' ? 'oil2' : 'oil4'];
    if (savings) total += savings * (escalatedPrice(priceKey, year) || 0);
  });
  return total;
}

// Compute annual carbon savings for a set of fuel quantities at a given year
function calcCarbonSavings(yr, year) {
  if (!utilFactors) return null;
  const period = PERIOD_FOR_YEAR[year] || '2050_plus';
  const ef = utilFactors[period];
  if (!ef) return null;
  let total = 0;
  // elec: savings_kwh × ef_kwh
  total += (yr.elec  || 0) * (ef.electricity_kwh     || 0);
  // gas: savings_therms × 100 kBtu/therm × ef_kbtu
  total += (yr.gas   || 0) * 100   * (ef.natural_gas_kbtu    || 0);
  // steam: savings_mLbs × 1194 kBtu/mLb × ef_kbtu
  total += (yr.steam || 0) * 1194  * (ef.district_steam_kbtu || 0);
  // oil2: savings_gal × 138.5 kBtu/gal × ef_kbtu
  total += (yr.oil2  || 0) * 138.5 * (ef.fuel_oil_2_kbtu     || 0);
  // oil4: savings_gal × 146.0 kBtu/gal × ef_kbtu
  total += (yr.oil4  || 0) * 146.0 * (ef.fuel_oil_4_kbtu     || 0);
  return total;
}

function fmtDollar(v) { return v != null && v > 0 ? '$' + Math.round(v).toLocaleString('en-US') : '—'; }
function fmtCarbon(v) { return v != null && v > 0.005 ? fmtNum(v) : '—'; }

function updateSummaryTable() {
  const section = document.getElementById('rp-summary-section');
  const tbody   = document.getElementById('rp-summary-tbody');
  const tfoot   = document.getElementById('rp-summary-tfoot');

  const activeYears = YEARS.filter(y => (placements[y] || []).length > 0);
  if (!activeYears.length) {
    section.classList.add('hidden');
    updateYearBadgeColors();
    return;
  }
  section.classList.remove('hidden');

  tbody.innerHTML = '';
  const totals = {cost: 0, elec: 0, gas: 0, steam: 0, oil2: 0, oil4: 0, costSav: 0, carbSav: 0};

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

    const costSav = calcCostSavings(yr, year);
    const carbSav = calcCarbonSavings(yr, year);

    totals.cost    += yr.cost;
    totals.elec    += yr.elec;
    totals.gas     += yr.gas;
    totals.steam   += yr.steam;
    totals.oil2    += yr.oil2;
    totals.oil4    += yr.oil4;
    if (costSav != null) totals.costSav += costSav;
    if (carbSav != null) totals.carbSav += carbSav;

    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="rp-sum-year">${year}</td>` +
      `<td class="rp-sum-names">${ms.map(m => escHtml(m.name)).join(', ')}</td>` +
      `<td class="rp-sum-cost">${yr.cost ? '$' + yr.cost.toLocaleString('en-US') : '—'}</td>` +
      `<td class="${yr.elec < 0 ? 'neg' : ''}">${yr.elec ? fmtNum(yr.elec) : '—'}</td>` +
      `<td class="${yr.gas < 0 ? 'neg' : ''}">${yr.gas ? fmtNum(yr.gas) : '—'}</td>` +
      `<td class="${yr.steam < 0 ? 'neg' : ''}">${yr.steam ? fmtNum(yr.steam) : '—'}</td>` +
      `<td class="${yr.oil2 < 0 ? 'neg' : ''}">${yr.oil2 ? fmtNum(yr.oil2) : '—'}</td>` +
      `<td class="${yr.oil4 < 0 ? 'neg' : ''}">${yr.oil4 ? fmtNum(yr.oil4) : '—'}</td>` +
      `<td>${fmtDollar(costSav)}</td>` +
      `<td>${fmtCarbon(carbSav)}</td>`;
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
    `<td>${totals.costSav > 0 ? '<strong>$' + Math.round(totals.costSav).toLocaleString('en-US') + '</strong>' : '—'}</td>` +
    `<td>${totals.carbSav > 0.005 ? '<strong>' + fmtNum(totals.carbSav) + '</strong>' : '—'}</td>` +
    `</tr>`;

  renderScenarioInsightBanner();
  updateYearBadgeColors();
}

// ── Scenario Insight Banner ───────────────────────────────────────────────────

// Returns cumulative annual fuel savings (in native units) from all measures
// placed in years <= the given year.
function getCumulativeSavingsAtYear(year) {
  const result = {elec: 0, gas: 0, steam: 0, oil2: 0, oil4: 0};
  Object.entries(placements).forEach(([yr, ids]) => {
    if (parseInt(yr, 10) <= year) {
      ids.forEach(id => {
        const m = measures.find(m => m.id === id);
        if (m) {
          result.elec  += m.elec_savings  || 0;
          result.gas   += m.gas_savings   || 0;
          result.steam += m.steam_savings || 0;
          result.oil2  += m.oil2_savings  || 0;
          result.oil4  += m.oil4_savings  || 0;
        }
      });
    }
  });
  return result;
}

function renderScenarioInsightBanner() {
  const el = document.getElementById('rp-scenario-insight');
  if (!el) return;

  const activeYears = YEARS.filter(y => (placements[y] || []).length > 0);
  if (!activeYears.length || !baselineResults || !utilFactors) {
    el.classList.add('hidden');
    return;
  }

  let baselineCumulativeFines = 0;
  let scenarioCumulativeFines = 0;
  let firstCompliancePeriod   = null;
  let anyBaselineNonCompliant = false;

  PERIOD_DEFS.forEach(pd => {
    const baseline = baselineResults[pd.key];
    if (!baseline) return;
    if (!baseline.compliant) anyBaselineNonCompliant = true;

    // Carbon savings from measures active at start of this period
    const sav = getCumulativeSavingsAtYear(pd.startYear);
    const ef  = utilFactors[pd.key] || {};
    const carbonSav =
      sav.elec  * (ef.electricity_kwh     || 0) +
      sav.gas   * 100   * (ef.natural_gas_kbtu    || 0) +
      sav.steam * 1194  * (ef.district_steam_kbtu || 0) +
      sav.oil2  * 138.5 * (ef.fuel_oil_2_kbtu     || 0) +
      sav.oil4  * 146.0 * (ef.fuel_oil_4_kbtu     || 0);

    const scenarioEmissions = Math.max(0, baseline.emissions - carbonSav);
    const limit             = baseline.limit;
    const scenarioCompliant = scenarioEmissions <= limit;

    baselineCumulativeFines += Math.max(0, baseline.emissions - limit) * 268 * pd.years;
    scenarioCumulativeFines += Math.max(0, scenarioEmissions  - limit) * 268 * pd.years;

    if (!baseline.compliant && scenarioCompliant && !firstCompliancePeriod) {
      firstCompliancePeriod = pd;
    }
  });

  const fineReduction = Math.round(baselineCumulativeFines - scenarioCumulativeFines);

  let html = '';
  if (!anyBaselineNonCompliant) {
    html = 'Your building is already projected to be compliant in all periods. This scenario further reduces emissions.';
  } else if (firstCompliancePeriod) {
    html = `This scenario brings the building into compliance starting in the <strong>${firstCompliancePeriod.label}</strong> period`;
    if (fineReduction > 0) {
      html += ` and reduces cumulative fines through 2050 by <strong>$${fineReduction.toLocaleString('en-US')}</strong>`;
    }
    html += '.';
  } else if (fineReduction > 0) {
    html = `This scenario reduces cumulative fines through 2050 by <strong>$${fineReduction.toLocaleString('en-US')}</strong>, but does not achieve full compliance in any period with the current measures.`;
  } else {
    el.classList.add('hidden');
    return;
  }

  el.innerHTML = html;
  el.classList.remove('hidden');
}

// ── Year badge compliance coloring ───────────────────────────────────────────

// Colors each year badge red if the building will incur a fine that year
// after applying all measures placed up to and including that year.
function updateYearBadgeColors() {
  if (!baselineResults || !utilFactors) return;
  YEARS.forEach(year => {
    const row = document.querySelector(`.rp-timeline-row[data-year="${year}"]`);
    if (!row) return;
    const badge = row.querySelector('.rp-year-badge');
    if (!badge) return;

    const pKey     = PERIOD_FOR_YEAR[year] || '2050_plus';
    const baseline = baselineResults[pKey];
    if (!baseline) return;

    const sav = getCumulativeSavingsAtYear(year);
    const ef  = utilFactors[pKey] || {};
    const carbonSav =
      sav.elec  * (ef.electricity_kwh     || 0) +
      sav.gas   * 100   * (ef.natural_gas_kbtu    || 0) +
      sav.steam * 1194  * (ef.district_steam_kbtu || 0) +
      sav.oil2  * 138.5 * (ef.fuel_oil_2_kbtu     || 0) +
      sav.oil4  * 146.0 * (ef.fuel_oil_4_kbtu     || 0);

    const scenarioEmissions = Math.max(0, baseline.emissions - carbonSav);
    const limit = baseline.limit;

    if (scenarioEmissions > limit) {
      const tonsOver = scenarioEmissions - limit;
      const fineAmt  = Math.round(tonsOver * 268);
      badge.classList.add('rp-year-badge-fine');
      badge.dataset.fineTip =
        'Fine: $' + fineAmt.toLocaleString('en-US') +
        ' \u00b7 ' + fmtNum(tonsOver) + ' tCO\u2082e over limit';
    } else {
      badge.classList.remove('rp-year-badge-fine');
      delete badge.dataset.fineTip;
    }
  });
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
    updateSuggestBtn();
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
    updateSuggestBtn();
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
    updateSuggestBtn();

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
      data.scenario.is_selected = false;
      scenarios.push(data.scenario);
      const sel = document.getElementById('rp-scenario-select');
      const opt = document.createElement('option');
      opt.value = data.scenario.id;
      opt.textContent = data.scenario.name;
      sel.appendChild(opt);
      currentScenarioId = data.scenario.id;
      sel.value = currentScenarioId;
      updateStarButton();
    }

    statusEl.textContent = 'Saved \u2713';
    statusEl.classList.add('rp-save-ok');
    markClean();
    showToast(asNew ? `${data.scenario.name} saved` : 'Scenario saved');
  } catch (e) {
    statusEl.textContent = 'Save failed';
    statusEl.classList.add('rp-save-error');
    showError('Save failed: ' + e.message);
  }
}

// ── Pencil dropdown menu ──────────────────────────────────────────────────────

function togglePencilMenu() {
  document.getElementById('rp-pencil-menu').classList.toggle('hidden');
}

function closePencilMenu() {
  document.getElementById('rp-pencil-menu').classList.add('hidden');
}

// ── Scenario rename (modal) ────────────────────────────────────────────────────

function openRenameModal() {
  closePencilMenu();
  const sel = document.getElementById('rp-scenario-select');
  const current = sel.options[sel.selectedIndex];
  const input = document.getElementById('rp-rename-input');
  const errEl = document.getElementById('rp-rename-error');
  input.value = current ? current.textContent.replace(/\s*★$/, '') : '';
  errEl.classList.add('hidden');
  document.getElementById('rp-rename-backdrop').classList.remove('hidden');
  input.focus();
  input.select();
}

function closeRenameModal() {
  document.getElementById('rp-rename-backdrop').classList.add('hidden');
}

async function confirmRename() {
  const input = document.getElementById('rp-rename-input');
  const errEl = document.getElementById('rp-rename-error');
  const name  = (input.value || '').trim();
  if (!name) {
    errEl.textContent = 'Name is required.';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  try {
    const resp = await fetch(`/api/scenarios/${currentScenarioId}/rename`, {
      method:  'POST',
      headers: {'Content-Type': 'application/json'},
      body:    JSON.stringify({name}),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Rename failed');

    const sel = document.getElementById('rp-scenario-select');
    const opt = sel.options[sel.selectedIndex];
    if (opt) opt.textContent = data.scenario.name + (currentScenarioId === selectedScenarioId ? ' ★' : '');
    const s = scenarios.find(x => x.id === currentScenarioId);
    if (s) s.name = data.scenario.name;

    closeRenameModal();
    showToast('Scenario renamed');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

// ── Delete scenario ────────────────────────────────────────────────────────────

async function deleteScenario() {
  closePencilMenu();
  document.getElementById('rp-save-dropdown').classList.add('hidden');

  const sel = document.getElementById('rp-scenario-select');
  const opt = sel.options[sel.selectedIndex];
  const scenName = opt ? opt.textContent : 'this scenario';

  if (!confirm(`Are you sure you want to delete "${scenName}"?\n\nThis will not delete any of the measures themselves.`)) return;

  try {
    const resp = await fetch(`/api/scenarios/${currentScenarioId}`, {method: 'DELETE'});
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Delete failed');

    scenarios = scenarios.filter(s => s.id !== currentScenarioId);
    opt && opt.remove();

    if (scenarios.length === 0) {
      // Auto-create a replacement scenario
      const saveResp = await fetch('/api/scenarios/save', {
        method:  'POST',
        headers: {'Content-Type': 'application/json'},
        body:    JSON.stringify({building_save_name: currentBuilding, placements: []}),
      });
      const saveData = await saveResp.json();
      scenarios = [saveData.scenario];
      const newOpt = document.createElement('option');
      newOpt.value = saveData.scenario.id;
      newOpt.textContent = saveData.scenario.name;
      sel.appendChild(newOpt);
    }

    currentScenarioId = scenarios[0].id;
    sel.value = currentScenarioId;
    placements = {};
    await loadScenarioPlacements(currentScenarioId);
    renderAllTimelineYears();
    renderMeasuresList();
    updateSummaryTable();
    markClean();
    showToast('Scenario deleted');
  } catch (e) {
    showError('Delete failed: ' + e.message);
  }
}

// ── Clear all placements ───────────────────────────────────────────────────────

function clearAllPlacements() {
  if (!Object.keys(placements).some(y => (placements[y] || []).length > 0)) return;
  if (!confirm('Remove all measures from this scenario\'s timeline?')) return;
  placements = {};
  renderAllTimelineYears();
  renderMeasuresList();
  updateSummaryTable();
  markDirty();
}

// ── Event listeners ───────────────────────────────────────────────────────────

function bindEventListeners() {
  // Scenario selector
  document.getElementById('rp-scenario-select').addEventListener('change', async function() {
    closePencilMenu();
    currentScenarioId = parseInt(this.value, 10);
    updateStarButton();
    await loadScenarioPlacements(currentScenarioId);
    renderAllTimelineYears();
    renderMeasuresList();
    updateSummaryTable();
  });

  // Star/select scenario button
  document.getElementById('rp-star-btn').addEventListener('click', async () => {
    const newSelectedId = (currentScenarioId === selectedScenarioId) ? null : currentScenarioId;
    try {
      const resp = await fetch(`/api/buildings/${encodeURIComponent(currentBuilding)}/select-scenario`, {
        method:  'POST',
        headers: {'Content-Type': 'application/json'},
        body:    JSON.stringify({scenario_id: newSelectedId}),
      });
      if (resp.ok) {
        selectedScenarioId = newSelectedId;
        // Re-render the dropdown to show star indicators
        const sel = document.getElementById('rp-scenario-select');
        const currentVal = sel.value;
        sel.innerHTML = '';
        scenarios.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name + (s.id === selectedScenarioId ? ' ★' : '');
          sel.appendChild(opt);
        });
        sel.value = currentVal;
        updateStarButton();
        const msg = newSelectedId
          ? 'Scenario marked as Selected — it will appear on Calculate and Portfolio.'
          : 'Selected Scenario cleared.';
        showSaveStatus(msg);
      }
    } catch (e) {
      showSaveStatus('Could not update selected scenario.', true);
    }
  });

  // Pencil dropdown
  document.getElementById('rp-pencil-btn').addEventListener('click', e => {
    e.stopPropagation();
    togglePencilMenu();
  });
  document.getElementById('rp-pencil-rename').addEventListener('click', openRenameModal);
  document.getElementById('rp-pencil-delete').addEventListener('click', deleteScenario);
  document.addEventListener('click', e => {
    if (!e.target.closest('#rp-pencil-wrap')) closePencilMenu();
  });

  // Rename modal
  document.getElementById('rp-rename-confirm').addEventListener('click', confirmRename);
  document.getElementById('rp-rename-cancel').addEventListener('click', closeRenameModal);
  document.getElementById('rp-rename-close').addEventListener('click', closeRenameModal);
  document.getElementById('rp-rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmRename();
    if (e.key === 'Escape') closeRenameModal();
  });
  document.getElementById('rp-rename-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeRenameModal();
  });

  // Clear all placements
  document.getElementById('rp-clear-all-btn').addEventListener('click', clearAllPlacements);

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

  // Delete scenario (from save dropdown)
  document.getElementById('rp-delete-scenario-btn').addEventListener('click', deleteScenario);

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

  // Cost validation on blur for add form
  const costInput = document.getElementById('rp-cost');
  if (costInput) costInput.addEventListener('blur', () => checkCostField(costInput));

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

  // Nav guard — show unsaved-changes modal before leaving with unsaved changes
  // Also pass scenario ID to Timeline whenever navigating there
  document.querySelectorAll('.nav-link, .nav-dropdown-item').forEach(link => {
    link.addEventListener('click', e => {
      const href = link.getAttribute('href');
      if (!href || href === '#' || href === window.location.pathname) return;
      const goingToTimeline = href === '/manage';
      // Always store scenario for Timeline nav (clean or dirty)
      if (goingToTimeline && currentScenarioId) {
        localStorage.setItem('ll97_rp_scenario_id', String(currentScenarioId));
      }
      if (!isDirty) return;
      e.preventDefault();
      showUnsavedModal(href, goingToTimeline);
    });
  });

  // "See Scenario on Timeline" button
  document.getElementById('rp-see-timeline-btn').addEventListener('click', () => {
    if (isDirty) {
      showUnsavedModal('/manage', true);
    } else {
      _pendingNavHref       = '/manage';
      _pendingNavIsTimeline = true;
      doNavigate();
    }
  });

  // Unsaved-changes modal
  document.getElementById('rp-unsaved-save').addEventListener('click', async () => {
    document.getElementById('rp-unsaved-backdrop').classList.add('hidden');
    await saveScenario(false);
    doNavigate();
  });
  document.getElementById('rp-unsaved-skip').addEventListener('click', () => {
    document.getElementById('rp-unsaved-backdrop').classList.add('hidden');
    doNavigate();
  });
  document.getElementById('rp-unsaved-cancel').addEventListener('click', () => {
    document.getElementById('rp-unsaved-backdrop').classList.add('hidden');
    _pendingNavHref       = null;
    _pendingNavIsTimeline = false;
  });

  // Suggest Plan modal
  document.getElementById('rp-suggest-btn').addEventListener('click', openSuggestModal);
  document.getElementById('rp-suggest-close').addEventListener('click', closeSuggestModal);
  document.getElementById('rp-suggest-cancel-btn').addEventListener('click', closeSuggestModal);
  document.getElementById('rp-suggest-run-btn').addEventListener('click', runSuggestPlan);
  document.getElementById('rp-suggest-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSuggestModal();
  });
  document.getElementById('rp-suggest-use-discount').addEventListener('change', function() {
    document.getElementById('rp-suggest-discount-row').classList.toggle('hidden', !this.checked);
  });

  // Ctrl/Cmd+S shortcut — save current scenario
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (currentBuilding) saveScenario(false);
    }
  });

  // Touch drag-and-drop — document-level move/end handlers (registered once)
  document.addEventListener('touchmove', e => {
    if (_tdId === null) return;
    const t = e.touches[0];
    if (!_tdActive) {
      if (Math.hypot(t.clientX - _tdStartX, t.clientY - _tdStartY) < 6) return;
      _tdActive = true;
      _tdStart(_tdEl);
    }
    e.preventDefault(); // prevent scroll while dragging
    const hw = _tdClone ? _tdClone.offsetWidth / 2 : 0;
    const hh = _tdClone ? _tdClone.offsetHeight / 2 : 0;
    if (_tdClone) { _tdClone.style.left = (t.clientX - hw) + 'px'; _tdClone.style.top = (t.clientY - hh) + 'px'; }

    // Highlight drop targets
    if (_tdClone) _tdClone.style.display = 'none';
    const under = document.elementFromPoint(t.clientX, t.clientY);
    if (_tdClone) _tdClone.style.display = '';
    document.querySelectorAll('.drag-over, .drag-target')
      .forEach(el => el.classList.remove('drag-over', 'drag-target'));
    const zone = under?.closest('.rp-drop-zone');
    if (zone) zone.classList.add('drag-over');
    if (_tdType === 'from-timeline') {
      const list = under?.closest('#rp-measures-list');
      if (list) list.classList.add('drag-target');
    }
  }, {passive: false});

  document.addEventListener('touchend', e => {
    if (_tdId === null || !_tdActive) { _tdClear(); return; }
    const t = e.changedTouches[0];
    // Snapshot state before _tdClear() resets it
    const dropId = _tdId, dropType = _tdType, dropSrc = _tdSrc;
    // Read drop target before removing clone
    if (_tdClone) _tdClone.style.display = 'none';
    const under = document.elementFromPoint(t.clientX, t.clientY);
    _tdClear();
    const zone = under?.closest('.rp-drop-zone');
    const list = under?.closest('#rp-measures-list');
    if (zone) {
      // Temporarily restore state for _tdDropToYear
      _tdId = dropId; _tdType = dropType; _tdSrc = dropSrc;
      _tdDropToYear(parseInt(zone.dataset.year, 10));
      _tdId = _tdType = _tdSrc = null;
    } else if (list && dropType === 'from-timeline' && dropSrc) {
      removePlacement(dropSrc, dropId);
    }
  }, {passive: true});

  document.addEventListener('touchcancel', () => { _tdClear(); }, {passive: true});
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

function showSaveStatus(msg, isError = false) {
  const statusEl = document.getElementById('rp-save-status');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = 'rp-save-status ' + (isError ? 'rp-save-error' : 'rp-save-ok');
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'rp-save-status'; }, 4000);
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

// ── Dirty tracking ─────────────────────────────────────────────────────────────

function markDirty() {
  isDirty = true;
  updateActiveChip(true);
}

function markClean() {
  isDirty = false;
  updateActiveChip(false);
}

function showUnsavedModal(href, isTimeline) {
  _pendingNavHref       = href;
  _pendingNavIsTimeline = isTimeline;
  document.getElementById('rp-unsaved-backdrop').classList.remove('hidden');
}

function doNavigate() {
  if (_pendingNavIsTimeline && currentScenarioId) {
    localStorage.setItem('ll97_rp_scenario_id', String(currentScenarioId));
  }
  isDirty = false;  // prevent beforeunload from firing
  window.location.href = _pendingNavHref;
}


function updateActiveChip(dirty) {
  const chip = document.querySelector('#active-building-nav .active-building-chip');
  if (chip) chip.classList.toggle('dirty', dirty);
}

function updateSuggestBtn() {
  const btn = document.getElementById('rp-suggest-btn');
  if (btn) btn.disabled = measures.length === 0;
}

// ── Suggest Plan modal ─────────────────────────────────────────────────────────

function openSuggestModal() {
  const statusEl = document.getElementById('rp-suggest-status');
  statusEl.textContent = '';
  statusEl.className = 'rp-suggest-status hidden';
  document.getElementById('rp-suggest-backdrop').classList.remove('hidden');
}

function closeSuggestModal() {
  document.getElementById('rp-suggest-backdrop').classList.add('hidden');
}

async function runSuggestPlan() {
  const mode  = document.querySelector('input[name="rp-suggest-mode"]:checked')?.value  || 'minimize_cost';
  const scope = document.querySelector('input[name="rp-suggest-scope"]:checked')?.value || 'all';
  const useDiscount  = document.getElementById('rp-suggest-use-discount').checked;
  const discountRate = parseFloat(document.getElementById('rp-suggest-discount-rate').value) || 5;
  const statusEl = document.getElementById('rp-suggest-status');

  if (scope === 'all' && isDirty) {
    if (!confirm('Running "All Measures" will replace your unsaved scenario placements. Continue?')) {
      return;
    }
  }

  statusEl.textContent = 'Computing…';
  statusEl.className = 'rp-suggest-status';

  try {
    const resp = await fetch('/api/suggest-plan', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        building_save_name: currentBuilding,
        mode,
        scope,
        use_discount:       useDiscount,
        discount_rate:      discountRate,
        electricity_kwh:    baselineEnergy?.elec  || 0,
        natural_gas_therms: baselineEnergy?.gas   || 0,
        district_steam_mlb: baselineEnergy?.steam || 0,
        fuel_oil_2_gal:     baselineEnergy?.fo2   || 0,
        fuel_oil_4_gal:     baselineEnergy?.fo4   || 0,
        occupancy_groups:   baselineOccupancyGroups || [],
        current_placements: scope === 'unplaced' ? buildPlacementsPayload() : [],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Suggest failed');

    const suggested = data.placements || [];
    if (scope === 'all') placements = {};
    suggested.forEach(p => {
      if (!placements[p.year]) placements[p.year] = [];
      if (!placements[p.year].includes(p.measure_id)) {
        placements[p.year].push(p.measure_id);
      }
    });

    renderAllTimelineYears();
    renderMeasuresList();
    updateSummaryTable();
    markDirty();
    closeSuggestModal();
    showToast(`Suggested ${suggested.length} placement(s)`);
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
    statusEl.className = 'rp-suggest-status rp-suggest-error';
  }
}
