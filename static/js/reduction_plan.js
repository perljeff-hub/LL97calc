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

// ── State ────────────────────────────────────────────────────────────────────

let currentBuilding   = '';
let measures          = [];   // [{id, name, cost, elec_savings, ...}]
let scenarios         = [];   // [{id, name, number}]
let currentScenarioId = null;
// placements: year (number) → [measureId, ...]
let placements        = {};

// ── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) { showNoBuilding(); return; }
    const state = JSON.parse(raw);
    if (!state.saveName) { showNoBuilding(); return; }
    currentBuilding = state.saveName;
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
  list.querySelectorAll('.rp-measure-card').forEach(el => el.remove());

  if (!measures.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const placed = getPlacedIds();
  measures.forEach(m => {
    list.appendChild(makeMeasureCard(m, placed.has(m.id)));
  });
}

function makeMeasureCard(m, isPlaced) {
  const card      = document.createElement('div');
  card.className  = 'rp-measure-card' + (isPlaced ? ' rp-measure-placed' : '');
  card.dataset.id = m.id;
  card.draggable  = !isPlaced;

  const info      = document.createElement('div');
  info.className  = 'rp-measure-info';

  const name      = document.createElement('div');
  name.className  = 'rp-measure-name';
  name.textContent = m.name;

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

  info.appendChild(name);
  info.appendChild(meta);
  card.appendChild(info);

  // Delete button
  const del      = document.createElement('button');
  del.className  = 'rp-measure-delete';
  del.title      = 'Delete measure';
  del.innerHTML  = '&times;';
  del.addEventListener('click', e => { e.stopPropagation(); deleteMeasure(m.id); });
  card.appendChild(del);

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
      `<td class="rp-sum-names">${ms.map(m => m.name).join(', ')}</td>` +
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

  // File upload
  document.getElementById('rp-upload-input').addEventListener('change', function() {
    if (this.files && this.files[0]) handleUpload(this.files[0]);
    this.value = '';
  });
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
