/* LL97 Calculator — Frontend Logic */

'use strict';

// ── STATE ──────────────────────────────────────────────────────────────────────
let occRowCount = 0;
// Tracks the save_name if this building was loaded from / saved to savedbuildings.db.
// null = building has never been saved in this session.
let currentSaveName = null;
// Full building metadata snapshot from the last search result selected.
// Used when building the save payload so we preserve bbl/bin/address/etc.
let currentBuildingData = null;

// ── OCCUPANCY GROUP MANAGER ───────────────────────────────────────────────────
function buildOccRow(index, defaultType = '', defaultArea = '') {
  const id = `occ-${index}`;
  const row = document.createElement('div');
  row.className = 'occ-row';
  row.id = id;

  // Property type select
  const select = document.createElement('select');
  select.name = `occ-type-${index}`;
  select.id = `occ-type-${index}`;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— Select ESPM Property Type —';
  select.appendChild(placeholder);
  (window.ESPM_PROPERTY_TYPES || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (t === defaultType) opt.selected = true;
    select.appendChild(opt);
  });

  // Floor area input
  const areaWrap = document.createElement('div');
  areaWrap.className = 'occ-area';
  const areaInput = document.createElement('input');
  areaInput.type = 'number';
  areaInput.name = `occ-area-${index}`;
  areaInput.id = `occ-area-${index}`;
  areaInput.className = 'form-input';
  areaInput.min = '0';
  areaInput.placeholder = 'Sq ft';
  areaInput.value = defaultArea;
  areaWrap.appendChild(areaInput);

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'occ-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateRemoveButtons();
  });

  row.appendChild(select);
  row.appendChild(areaWrap);
  row.appendChild(removeBtn);
  return row;
}

function addOccRow(type = '', area = '') {
  const container = document.getElementById('occupancy-groups');
  if (container.querySelectorAll('.occ-row').length === 0) {
    // Add header row
    const header = document.createElement('div');
    header.className = 'occ-header';
    header.id = 'occ-header';
    header.innerHTML = `
      <span>ESPM Property Type</span>
      <span style="width:160px">Gross Floor Area (sq ft)</span>
      <span></span>
    `;
    container.insertBefore(header, container.firstChild);
  }
  const row = buildOccRow(occRowCount++, type, area);
  container.appendChild(row);
  updateRemoveButtons();
  updateAddButton();
}

function updateRemoveButtons() {
  const rows = document.querySelectorAll('#occupancy-groups .occ-row');
  rows.forEach(r => {
    const btn = r.querySelector('.occ-remove');
    btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
  });
}

function updateAddButton() {
  const count = document.querySelectorAll('#occupancy-groups .occ-row').length;
  document.getElementById('add-occ-btn').style.display = count >= 4 ? 'none' : 'inline-flex';
}

function getOccupancyGroups() {
  const groups = [];
  document.querySelectorAll('#occupancy-groups .occ-row').forEach(row => {
    const idx = row.id.replace('occ-', '');
    const type = document.getElementById(`occ-type-${idx}`)?.value || '';
    const area = parseFloat(document.getElementById(`occ-area-${idx}`)?.value) || 0;
    if (type && area > 0) groups.push({ property_type: type, floor_area: area });
  });
  return groups;
}

// ── SEARCH ─────────────────────────────────────────────────────────────────────
let searchTimeout = null;

document.getElementById('search-input').addEventListener('input', function () {
  clearTimeout(searchTimeout);
  const q = this.value.trim();
  if (q.length < 3) {
    document.getElementById('search-results').classList.add('hidden');
    return;
  }
  searchTimeout = setTimeout(() => performSearch(q), 350);
});

document.getElementById('search-btn').addEventListener('click', () => {
  const q = document.getElementById('search-input').value.trim();
  if (q.length >= 3) performSearch(q);
});

async function performSearch(q) {
  const resultsEl = document.getElementById('search-results');
  const dbStatusEl = document.getElementById('db-status-msg');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="search-result-item" style="color:#868e96">Searching…</div>';

  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await resp.json();

    if (data.warning) {
      dbStatusEl.textContent = data.warning;
      dbStatusEl.classList.remove('hidden');
    } else {
      dbStatusEl.classList.add('hidden');
    }

    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div class="search-result-item" style="color:#868e96">No buildings found.</div>';
      return;
    }

    resultsEl.innerHTML = '';
    data.results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result-item';

      if (r.source === 'saved') {
        // Saved building — highlight as User Defined
        const floor = r.gross_floor_area ? `${fmtNum(r.gross_floor_area)} sf` : '';
        const sub = [r.address, r.borough, r.postcode].filter(Boolean).join(' ');
        item.innerHTML = `
          <div class="sri-main">${esc(r.save_name)} <span class="badge badge-saved">User Defined</span></div>
          <div class="sri-sub">${esc(sub)}${r.bbl ? ` &bull; BBL: ${esc(r.bbl)}` : ''}${r.bin ? ` &bull; BIN: ${esc(r.bin)}` : ''}</div>
          <div class="sri-meta">${floor ? floor + ' &bull; ' : ''}Saved building</div>
        `;
      } else {
        // LL84 building — existing display
        const floor = r.gross_floor_area ? `${fmtNum(r.gross_floor_area)} sf` : '';
        const es = r.energy_star_score ? `ES Score: ${r.energy_star_score}` : '';
        const binStr = r.bin ? `BIN: ${esc(r.bin)}` : '';
        item.innerHTML = `
          <div class="sri-main">${esc(r.property_name || r.address || 'Unknown')}</div>
          <div class="sri-sub">${esc(r.address || '')} ${esc(r.borough || '')} ${esc(r.postcode || '')} &bull; BBL: ${esc(r.bbl || '')}${binStr ? ` &bull; ${binStr}` : ''}</div>
          <div class="sri-meta">${floor}${floor && es ? ' &bull; ' : ''}${es}${r.year_ending ? ` &bull; Data year: ${r.year_ending.substring(0,4)}` : ''}</div>
        `;
      }

      item.addEventListener('click', () => populateFromBuilding(r));
      resultsEl.appendChild(item);
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="search-result-item" style="color:#c0392b">Search failed. Please try again.</div>';
  }
}

function populateFromBuilding(r) {
  // Track session state
  currentBuildingData = r;
  currentSaveName = (r.source === 'saved') ? r.save_name : null;
  updateSaveNameLabel();

  // Step 1: zero out ALL energy fields first
  ['elec', 'gas', 'steam', 'fo2', 'fo4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Step 2: clear stale results and errors
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('save-action-row').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');

  // Step 3: repopulate energy inputs (API returns natural units)
  setValue('elec',  r.electricity_kwh);
  setValue('gas',   r.natural_gas_therms);
  setValue('steam', r.district_steam_mlb);
  setValue('fo2',   r.fuel_oil_2_gal);
  setValue('fo4',   r.fuel_oil_4_gal);

  // Step 4: clear and repopulate occupancy groups
  const container = document.getElementById('occupancy-groups');
  container.innerHTML = '';
  occRowCount = 0;

  const groups = r.occupancy_groups || [];
  if (groups.length > 0) {
    groups.forEach(g => addOccRow(g.property_type || '', g.floor_area || ''));
  } else {
    addOccRow('', r.gross_floor_area || '');
  }

  // Step 5: populate Selected Building panel
  const bldgSection = document.getElementById('selected-building-section');
  const bldgGrid = document.getElementById('bldg-info-grid');

  const makeItem = f => `<div class="bldg-info-item">
    <div class="bldg-info-label">${f.label}</div>
    <div class="bldg-info-value">${esc(String(f.value))}</div>
  </div>`;

  // For saved buildings, use save_name as the label in the panel
  const displayName = (r.source === 'saved') ? r.save_name : (r.property_name || '—');

  const row1 = [
    { label: r.source === 'saved' ? 'Saved Name' : 'Property Name', value: displayName },
    { label: 'BBL',       value: r.bbl || '—' },
    { label: 'BIN',       value: r.bin || '—' },
    { label: 'Data Year', value: r.year_ending ? String(r.year_ending).substring(0,4) : '—' },
  ];
  const row2 = [
    { label: 'Address',          value: r.address || '—' },
    { label: 'Borough',          value: r.borough || '—' },
    { label: 'Zip Code',         value: r.postcode || '—' },
    { label: 'Gross Floor Area', value: r.gross_floor_area ? fmtNum(r.gross_floor_area) + ' sf' : '—' },
    { label: 'Energy Star Score',value: r.energy_star_score || '—' },
  ];

  bldgGrid.innerHTML =
    `<div class="bldg-info-row bldg-info-row-4">${row1.map(makeItem).join('')}</div>` +
    `<div class="bldg-info-row bldg-info-row-5">${row2.map(makeItem).join('')}</div>`;
  bldgSection.classList.remove('hidden');

  // Step 6: close search dropdown and update search field
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-input').value =
    (r.source === 'saved') ? r.save_name : (r.property_name || r.address || '');

  // Step 7: scroll to selected building section
  bldgSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null && val !== '') el.value = val;
}

// ── CALCULATE ─────────────────────────────────────────────────────────────────
document.getElementById('calculate-btn').addEventListener('click', runCalculation);
document.getElementById('clear-btn').addEventListener('click', clearAll);

async function runCalculation() {
  const errEl = document.getElementById('error-msg');
  errEl.classList.add('hidden');

  const groups = getOccupancyGroups();
  if (groups.length === 0) {
    errEl.textContent = 'Please add at least one occupancy group with a floor area.';
    errEl.classList.remove('hidden');
    return;
  }

  const hasEnergy = ['elec','gas','steam','fo2','fo4'].some(id => {
    const v = parseFloat(document.getElementById(id).value);
    return v > 0;
  });
  if (!hasEnergy) {
    errEl.textContent = 'Please enter at least one non-zero energy consumption value.';
    errEl.classList.remove('hidden');
    return;
  }

  const payload = {
    electricity_kwh:      getVal('elec'),
    natural_gas_therms:   getVal('gas'),
    district_steam_mlb:   getVal('steam'),
    fuel_oil_2_gal:       getVal('fo2'),
    fuel_oil_4_gal:       getVal('fo4'),
    occupancy_groups:     groups,
    price_electricity:    getVal('p-elec'),
    price_natural_gas:    getVal('p-gas'),
    price_district_steam: getVal('p-steam'),
    price_fuel_oil_2:     getVal('p-fo2'),
    price_fuel_oil_4:     getVal('p-fo4'),
  };

  try {
    const resp = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      errEl.textContent = data.error || 'Calculation error.';
      errEl.classList.remove('hidden');
      return;
    }
    renderResults(data);
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
    errEl.classList.remove('hidden');
  }
}

function getVal(id) {
  const v = parseFloat(document.getElementById(id)?.value);
  return isNaN(v) ? null : v;
}

// ── RENDER RESULTS ────────────────────────────────────────────────────────────
function renderResults(data) {
  const resultsSection = document.getElementById('results-section');
  resultsSection.classList.remove('hidden');

  renderCosts(data.utility_costs, data.total_floor_area);
  renderPeriods(data.results, data.total_floor_area);

  // Show Save button whenever results are visible
  document.getElementById('save-action-row').classList.remove('hidden');

  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCosts(costs, totalSf) {
  const grid = document.getElementById('costs-grid');
  const labels = {
    electricity:    'Electricity',
    natural_gas:    'Natural Gas',
    district_steam: 'District Steam',
    fuel_oil_2:     '#2 Fuel Oil',
    fuel_oil_4:     '#4 Fuel Oil',
    total:          'Total Utility Cost',
  };
  const keys = ['electricity','natural_gas','district_steam','fuel_oil_2','fuel_oil_4','total'];
  grid.innerHTML = '';
  keys.forEach(k => {
    const val = costs[k] || 0;
    if (k !== 'total' && val === 0) return;
    const item = document.createElement('div');
    item.className = `cost-item${k === 'total' ? ' total' : ''}`;
    const perSf = totalSf ? (val / totalSf).toFixed(2) : '—';
    item.innerHTML = `
      <div class="cost-label">${labels[k]}</div>
      <div class="cost-value">${fmtDollars(val)}</div>
      ${k !== 'total' ? `<div class="cost-per-sf">$${perSf}/sf</div>` : `<div class="cost-per-sf">$${(val/totalSf).toFixed(2)}/sf</div>`}
    `;
    grid.appendChild(item);
  });
}

function renderPeriods(results, totalSf) {
  const grid = document.getElementById('periods-grid');
  grid.innerHTML = '';

  const periods = window.COMPLIANCE_PERIODS || [];
  periods.forEach(period => {
    const r = results[period];
    if (!r) return;

    const isZero = r.limit === 0;
    const compliant = r.compliant;
    const statusClass = isZero ? 'zero-limit' : (compliant ? 'compliant' : 'non-compliant');
    const statusText = isZero ? '2050 Target: 0' : (compliant ? '✓ Compliant' : '✗ Non-Compliant');

    const col = document.createElement('div');
    col.className = `period-col ${statusClass}`;

    const pct = r.limit > 0 ? Math.min(100, (r.emissions / r.limit) * 100) : 0;
    const barClass = compliant ? 'ok' : 'over';

    const breakdownSources = [
      { key: 'electricity',    label: 'Electricity' },
      { key: 'natural_gas',    label: 'Natural Gas' },
      { key: 'district_steam', label: 'District Steam' },
      { key: 'fuel_oil_2',     label: '#2 Fuel Oil' },
      { key: 'fuel_oil_4',     label: '#4 Fuel Oil' },
    ];
    const breakdown = r.breakdown || {};
    const totalEmissions = r.emissions || 0;
    const miniBarHtml = breakdownSources
      .filter(src => (breakdown[src.key] || 0) > 0)
      .map(src => {
        const val = breakdown[src.key] || 0;
        const pctStr = totalEmissions > 0 ? ((val / totalEmissions) * 100).toFixed(1) : '0';
        return `<div class="mini-bar-item">
          <div class="mini-bar-top">
            <span>${src.label}</span>
            <span>${fmtTons(val)}t (${pctStr}%)</span>
          </div>
          <div class="mini-bar-track">
            <div class="mini-bar-fill bar-${src.key}" style="width:${pctStr}%"></div>
          </div>
        </div>`;
      }).join('');

    col.innerHTML = `
      <div class="period-header">${esc(r.label)}</div>
      <div class="period-status">${statusText}</div>
      <div class="period-body">
        <div class="period-metric">
          <div class="period-metric-label">GHG Emissions</div>
          <div class="period-metric-value">${fmtTons(r.emissions)}</div>
          <div class="period-metric-sub">tCO₂e/yr &bull; ${fmtKgSf(r.intensity_kg)} kgCO₂e/sf</div>
        </div>
        <div class="period-metric">
          <div class="period-metric-label">Emissions Limit</div>
          <div class="period-metric-value">${isZero ? '0' : fmtTons(r.limit)}</div>
          <div class="period-metric-sub">tCO₂e/yr &bull; ${isZero ? '0' : fmtKgSf(r.limit_intensity_kg)} kgCO₂e/sf</div>
        </div>
        ${!isZero ? `
        <div class="compliance-bar-wrap">
          <div class="compliance-bar ${barClass}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <div class="compliance-bar-label">${pct.toFixed(0)}% of limit</div>
        ` : ''}
        <div class="period-divider"></div>
        <div class="period-metric">
          <div class="period-metric-label">Overage</div>
          <div class="period-metric-value">${r.overage > 0 ? fmtTons(r.overage) + ' tCO₂e' : '—'}</div>
        </div>
        <div class="period-metric">
          <div class="period-metric-label">Annual Penalty</div>
          <div class="penalty-value ${r.penalty === 0 ? 'zero' : ''}">${r.penalty === 0 ? '$0' : fmtDollars(r.penalty)}</div>
        </div>
        ${miniBarHtml ? `
        <div class="period-divider"></div>
        <div class="period-breakdown">
          <div class="period-breakdown-title">Emissions Breakdown</div>
          ${miniBarHtml}
        </div>
        ` : ''}
      </div>
    `;
    grid.appendChild(col);
  });
}

// ── CLEAR ─────────────────────────────────────────────────────────────────────
function clearAll() {
  ['elec','gas','steam','fo2','fo4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('save-action-row').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');

  // Hide and clear selected building section
  document.getElementById('selected-building-section').classList.add('hidden');
  document.getElementById('bldg-info-grid').innerHTML = '';

  // Reset occupancy to one empty row
  const container = document.getElementById('occupancy-groups');
  container.innerHTML = '';
  occRowCount = 0;
  addOccRow();

  // Reset save state
  currentSaveName = null;
  currentBuildingData = null;
  updateSaveNameLabel();
}

// ── SAVE ──────────────────────────────────────────────────────────────────────

document.getElementById('save-building-btn').addEventListener('click', openSaveModal);
document.getElementById('save-modal-close').addEventListener('click', closeSaveModal);
document.getElementById('save-modal-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSaveModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSaveModal();
});

function openSaveModal() {
  const body = document.getElementById('save-modal-body');

  if (currentSaveName) {
    // Building was previously saved — offer overwrite OR save as new name
    body.innerHTML = `
      <div class="save-option">
        <p class="save-option-desc">Update the existing saved record:</p>
        <button class="btn btn-primary save-overwrite-btn" id="overwrite-confirm-btn">
          Save and Overwrite &ldquo;${esc(currentSaveName)}&rdquo;
        </button>
      </div>
      <div class="save-divider">— or save under a new name —</div>
      <div class="save-option">
        <label class="input-label" for="save-name-input">Save As Building Name:</label>
        <div class="save-input-row">
          <input type="text" class="form-input" id="save-name-input" placeholder="Enter a new name…" autocomplete="off" />
          <button class="btn btn-secondary" id="save-as-btn">Save As New</button>
        </div>
        <div id="save-name-error" class="save-name-error hidden"></div>
      </div>
    `;
    document.getElementById('overwrite-confirm-btn').addEventListener('click', () => {
      doSave(currentSaveName, true);
    });
    document.getElementById('save-as-btn').addEventListener('click', saveAsNew);
    document.getElementById('save-name-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') saveAsNew();
    });
  } else {
    // Building has never been saved — show Save As form only
    body.innerHTML = `
      <div class="save-option">
        <label class="input-label" for="save-name-input">Save As Building Name:</label>
        <div class="save-input-row">
          <input type="text" class="form-input" id="save-name-input" placeholder="Enter a name…" autocomplete="off" />
          <button class="btn btn-primary" id="save-as-btn">Save</button>
        </div>
        <div id="save-name-error" class="save-name-error hidden"></div>
      </div>
    `;
    document.getElementById('save-as-btn').addEventListener('click', saveAsNew);
    document.getElementById('save-name-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') saveAsNew();
    });
  }

  document.getElementById('save-modal-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('save-name-input')?.focus(), 50);
}

function saveAsNew() {
  const nameInput = document.getElementById('save-name-input');
  const name = (nameInput?.value || '').trim();
  if (!name) {
    showSaveNameError('Please enter a name.');
    nameInput?.focus();
    return;
  }
  doSave(name, false);
}

function closeSaveModal() {
  document.getElementById('save-modal-backdrop').classList.add('hidden');
}

function showSaveNameError(msg) {
  const el = document.getElementById('save-name-error');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

async function doSave(saveName, overwrite) {
  const building = collectCurrentBuilding();
  try {
    const resp = await fetch('/api/save-building', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save_name: saveName, overwrite, building }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      if (data.error === 'name_exists') {
        showSaveNameError('That name is already taken — please choose a different name.');
      } else {
        showSaveNameError(data.error || 'Save failed. Please try again.');
      }
      return;
    }

    // Success
    currentSaveName = saveName;
    updateSaveNameLabel();
    closeSaveModal();
    showSaveToast(`Saved as "${saveName}"`);
  } catch (e) {
    showSaveNameError('Network error. Please try again.');
  }
}

function collectCurrentBuilding() {
  const bd = currentBuildingData || {};
  return {
    bbl:               bd.bbl               || '',
    bin:               bd.bin               || '',
    property_name:     bd.property_name     || '',
    address:           bd.address           || '',
    borough:           bd.borough           || '',
    postcode:          bd.postcode          || '',
    year_ending:       bd.year_ending       || '',
    gross_floor_area:  bd.gross_floor_area  || null,
    energy_star_score: bd.energy_star_score || '',
    reported_ghg:      bd.reported_ghg      || null,
    // Current form values (may differ from LL84 data if user edited them)
    electricity_kwh:   getVal('elec'),
    natural_gas_therms: getVal('gas'),
    district_steam_mlb: getVal('steam'),
    fuel_oil_2_gal:    getVal('fo2'),
    fuel_oil_4_gal:    getVal('fo4'),
    occupancy_groups:  getOccupancyGroups(),
  };
}

function updateSaveNameLabel() {
  const el = document.getElementById('save-current-name');
  if (!el) return;
  el.textContent = currentSaveName ? `Currently saved as: "${currentSaveName}"` : '';
}

function showSaveToast(msg) {
  const toast = document.getElementById('save-toast');
  toast.textContent = msg;
  toast.classList.remove('hidden', 'fade-out');
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.classList.add('hidden'), 600);
  }, 2800);
}

// ── FORMATTING HELPERS ─────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtTons(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmtKgSf(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtDollars(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── INIT ───────────────────────────────────────────────────────────────────────
(async function init() {
  addOccRow();

  document.getElementById('add-occ-btn').addEventListener('click', () => {
    const count = document.querySelectorAll('#occupancy-groups .occ-row').length;
    if (count < 4) addOccRow();
  });

  // Check DB status
  try {
    const resp = await fetch('/api/db-status');
    const data = await resp.json();
    const msg = document.getElementById('db-status-msg');
    if (!data.initialized) {
      msg.textContent = 'Building database not yet loaded. Run: python app.py --init-db to enable building search.';
      msg.classList.remove('hidden');
    } else if (data.needs_reimport) {
      msg.innerHTML =
        '<strong>Database needs refresh:</strong> Your LL84 database is missing per-use floor area data. ' +
        'Stop the app and run <code>python app.py --reimport</code> to download a fresh copy. ' +
        'Until then, the building\'s total floor area is used as a fallback for the primary occupancy type.';
      msg.classList.remove('hidden');
    }
  } catch (e) { /* ignore */ }
})();
