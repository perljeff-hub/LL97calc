/* Select Building — Frontend Logic */
'use strict';

// ── STATE ──────────────────────────────────────────────────────────────────────
let occRowCount = 0;
let currentSaveName = null;
let currentBuildingData = null;
let isDirty = false;
let _loading = false;
let _energyPrices = {};

const EU_FUELS = [
  { inputId: 'elec',  priceKey: 'electricity_kwh',    unit: '/kWh',   priceElId: 'eu-price-elec',  costElId: 'eu-cost-elec'  },
  { inputId: 'gas',   priceKey: 'natural_gas_therm',  unit: '/therm', priceElId: 'eu-price-gas',   costElId: 'eu-cost-gas'   },
  { inputId: 'steam', priceKey: 'district_steam_mlb', unit: '/mLb',   priceElId: 'eu-price-steam', costElId: 'eu-cost-steam' },
  { inputId: 'fo2',   priceKey: 'fuel_oil_2_gal',     unit: '/gal',   priceElId: 'eu-price-fo2',   costElId: 'eu-cost-fo2'   },
  { inputId: 'fo4',   priceKey: 'fuel_oil_4_gal',     unit: '/gal',   priceElId: 'eu-price-fo4',   costElId: 'eu-cost-fo4'   },
];

const SESSION_KEY = 'll97_calc_state';
const ACTIVE_KEY  = 'll97_active';

// ── OCCUPANCY GROUP MANAGER ───────────────────────────────────────────────────
function buildOccRow(index, defaultType = '', defaultArea = '') {
  const id = `occ-${index}`;
  const row = document.createElement('div');
  row.className = 'occ-row';
  row.id = id;

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
  select.addEventListener('change', () => markDirty());

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
  areaInput.addEventListener('input', () => markDirty());
  areaWrap.appendChild(areaInput);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'occ-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateRemoveButtons();
    markDirty();
  });

  row.appendChild(select);
  row.appendChild(areaWrap);
  row.appendChild(removeBtn);
  return row;
}

function addOccRow(type = '', area = '') {
  const container = document.getElementById('occupancy-groups');
  if (container.querySelectorAll('.occ-row').length === 0) {
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

function getAllOccupancyRows() {
  const rows = [];
  document.querySelectorAll('#occupancy-groups .occ-row').forEach(row => {
    const idx = row.id.replace('occ-', '');
    rows.push({
      type: document.getElementById(`occ-type-${idx}`)?.value || '',
      area: document.getElementById(`occ-area-${idx}`)?.value || '',
    });
  });
  return rows;
}

// ── DIRTY STATE ───────────────────────────────────────────────────────────────
function markDirty() {
  if (_loading) return;
  isDirty = true;
  updateActiveBuildingNav();
  saveFormState();
}

function markClean() {
  isDirty = false;
  updateActiveBuildingNav();
}

// ── ENERGY PRICE DISPLAY ──────────────────────────────────────────────────────
async function loadEnergyPrices() {
  try {
    const resp = await fetch('/api/settings/prices');
    const data = await resp.json();
    _energyPrices = data.prices || {};
  } catch (e) { /* non-fatal */ }
  updateEnergyCosts();
}

function updateEnergyCosts() {
  let total = 0;
  let hasAnyPrice = false;
  EU_FUELS.forEach(f => {
    const priceEl = document.getElementById(f.priceElId);
    const costEl  = document.getElementById(f.costElId);
    const p = _energyPrices[f.priceKey];
    const price = (p && p.price != null) ? Number(p.price) : null;
    const usage = parseFloat(document.getElementById(f.inputId)?.value) || 0;
    if (priceEl) priceEl.textContent = price != null ? `$${price.toFixed(2)}${f.unit}` : '—';
    if (costEl) {
      if (price != null) {
        hasAnyPrice = true;
        if (usage > 0) { const cost = price * usage; total += cost; costEl.textContent = fmtDollars(cost); }
        else costEl.textContent = '';
      } else costEl.textContent = '';
    }
  });
  const totalEl = document.getElementById('eu-cost-total');
  if (totalEl) totalEl.textContent = (hasAnyPrice && total > 0) ? fmtDollars(total) : '—';
}

// ── ACTIVE BUILDING NAV CHIP ───────────────────────────────────────────────────
function updateActiveBuildingNav() {
  const nav = document.getElementById('active-building-nav');
  if (!nav) return;
  if (currentSaveName) {
    const dirtyAttr = isDirty ? ' dirty' : '';
    const r = currentBuildingData || {};
    let tipHtml = `<div class="abt-name">${esc(r.property_name || currentSaveName)}</div>`;
    if (r.address)          tipHtml += `<div class="abt-row">${esc(r.address)}${r.borough ? ', ' + esc(r.borough) : ''}${r.postcode ? ' ' + esc(r.postcode) : ''}</div>`;
    if (r.gross_floor_area) tipHtml += `<div class="abt-row"><strong>${Number(r.gross_floor_area).toLocaleString('en-US')}</strong> sq ft</div>`;
    const svgBuilding =
      `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0">`+
      `<rect x="3" y="4" width="10" height="11" rx=".5" stroke="currentColor" stroke-width="1.5"/>`+
      `<rect x="5" y="6" width="2" height="2" rx=".3" fill="currentColor"/>`+
      `<rect x="9" y="6" width="2" height="2" rx=".3" fill="currentColor"/>`+
      `<rect x="5" y="10" width="2" height="2" rx=".3" fill="currentColor"/>`+
      `<rect x="9" y="10" width="2" height="2" rx=".3" fill="currentColor"/>`+
      `<path d="M6.5 15V12h3v3" stroke="currentColor" stroke-width="1.3" fill="none"/>`+
      `<path d="M1 4l7-3 7 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`+
      `</svg>`;
    nav.innerHTML =
      `<div class="active-building-chip-wrap">`+
      `<span class="active-building-chip${dirtyAttr}">${svgBuilding}`+
      `<span class="active-building-chip-name">${esc(currentSaveName)}</span></span>`+
      `<div class="active-building-tooltip">${tipHtml}</div>`+
      `</div>`;
  } else {
    nav.innerHTML = '';
  }
  try {
    if (currentSaveName) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ saveName: currentSaveName }));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch (e) { /* ignore */ }
  syncNavState();
}

function syncNavState() {
  const calcLink = document.getElementById('calc-nav-link');
  const dd = document.getElementById('manage-nav-dropdown');
  const btn = document.getElementById('manage-nav-btn');
  if (currentSaveName) {
    if (calcLink) { calcLink.classList.remove('nav-link-disabled'); calcLink.removeAttribute('title'); }
    if (dd) { dd.classList.remove('disabled'); dd.removeAttribute('title'); }
    if (btn) btn.classList.remove('nav-link-disabled');
  } else {
    if (calcLink) { calcLink.classList.add('nav-link-disabled'); calcLink.setAttribute('title', 'Select a building to enable Calculate'); }
    if (dd) { dd.classList.add('disabled'); dd.setAttribute('title', 'Save or Load a Saved Building to enable Manage'); }
    if (btn) btn.classList.add('nav-link-disabled');
  }
}

// ── SESSION STORAGE ────────────────────────────────────────────────────────────
function saveFormState() {
  if (_loading) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      saveName:     currentSaveName,
      buildingData: currentBuildingData,
      isDirty,
      form: {
        elec:  document.getElementById('elec')?.value  || '',
        gas:   document.getElementById('gas')?.value   || '',
        steam: document.getElementById('steam')?.value || '',
        fo2:   document.getElementById('fo2')?.value   || '',
        fo4:   document.getElementById('fo4')?.value   || '',
      },
      occRows: getAllOccupancyRows(),
    }));
  } catch (e) { /* ignore */ }
}

function clearFormState() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTIVE_KEY);
  } catch (e) { /* ignore */ }
}

function restoreFormState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    _loading = true;
    currentSaveName    = state.saveName   || null;
    currentBuildingData = state.buildingData || null;
    isDirty            = !!state.isDirty;
    if (state.form) {
      setValue('elec',  state.form.elec);
      setValue('gas',   state.form.gas);
      setValue('steam', state.form.steam);
      setValue('fo2',   state.form.fo2);
      setValue('fo4',   state.form.fo4);
    }
    if (state.occRows && state.occRows.length > 0) {
      const container = document.getElementById('occupancy-groups');
      container.innerHTML = '';
      occRowCount = 0;
      state.occRows.forEach(r => addOccRow(r.type, r.area));
    }
    _loading = false;
    if (currentBuildingData) {
      renderBuildingPanel(currentBuildingData);
      const r = currentBuildingData;
      document.getElementById('search-input').value =
        (r.source === 'saved') ? r.save_name : (r.property_name || r.address || '');
    }
    updateActiveBuildingNav();
    updateSavePortfolioLink();
    return true;
  } catch (e) {
    _loading = false;
    return false;
  }
}

// ── SEARCH ─────────────────────────────────────────────────────────────────────
let searchTimeout = null;

document.getElementById('search-input').addEventListener('input', function () {
  clearTimeout(searchTimeout);
  const q = this.value.trim();
  if (q.length < 3) { document.getElementById('search-results').classList.add('hidden'); return; }
  searchTimeout = setTimeout(() => performSearch(q), 350);
});

document.getElementById('search-btn').addEventListener('click', () => {
  const q = document.getElementById('search-input').value.trim();
  if (q.length >= 3) performSearch(q);
});

async function performSearch(q) {
  const resultsEl = document.getElementById('search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="search-result-item" style="color:#868e96">Searching…</div>';
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await resp.json();
    if (data.warning) {
      const dbMsg = document.getElementById('db-status-msg');
      dbMsg.textContent = data.warning;
      dbMsg.classList.remove('hidden');
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
        const floor = r.gross_floor_area ? `${fmtNum(r.gross_floor_area)} sf` : '';
        const sub = [r.address, r.borough, r.postcode].filter(Boolean).join(' ');
        item.innerHTML = `
          <div class="sri-main">${esc(r.save_name)} <span class="badge badge-saved">Saved</span></div>
          <div class="sri-sub">${esc(sub)}${r.bbl ? ` &bull; BBL: ${esc(r.bbl)}` : ''}${r.bin ? ` &bull; BIN: ${esc(r.bin)}` : ''}</div>
          <div class="sri-meta">${floor ? floor + ' &bull; ' : ''}Portfolio building</div>
        `;
      } else {
        const floor = r.gross_floor_area ? `${fmtNum(r.gross_floor_area)} sf` : '';
        const es = r.energy_star_score ? `ES Score: ${r.energy_star_score}` : '';
        item.innerHTML = `
          <div class="sri-main">${esc(r.property_name || r.address || 'Unknown')}</div>
          <div class="sri-sub">${esc(r.address || '')} ${esc(r.borough || '')} ${esc(r.postcode || '')} &bull; BBL: ${esc(r.bbl || '')}${r.bin ? ` &bull; BIN: ${esc(r.bin)}` : ''}</div>
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

function renderBuildingPanel(r) {
  if (!r) return;
  const bldgSection = document.getElementById('selected-building-section');
  const bldgGrid = document.getElementById('bldg-info-grid');
  const makeItem = f => `<div class="bldg-info-item">
    <div class="bldg-info-label">${f.label}</div>
    <div class="bldg-info-value">${esc(String(f.value))}</div>
  </div>`;
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
}

function populateFromBuilding(r) {
  _loading = true;
  currentBuildingData = r;
  currentSaveName = (r.source === 'saved') ? r.save_name : null;

  document.getElementById('error-msg').classList.add('hidden');

  ['elec', 'gas', 'steam', 'fo2', 'fo4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  setValue('elec',  r.electricity_kwh);
  setValue('gas',   r.natural_gas_therms);
  setValue('steam', r.district_steam_mlb);
  setValue('fo2',   r.fuel_oil_2_gal);
  setValue('fo4',   r.fuel_oil_4_gal);

  const container = document.getElementById('occupancy-groups');
  container.innerHTML = '';
  occRowCount = 0;
  const groups = r.occupancy_groups || [];
  if (groups.length > 0) groups.forEach(g => addOccRow(g.property_type || '', g.floor_area || ''));
  else addOccRow('', r.gross_floor_area || '');

  renderBuildingPanel(r);
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('search-input').value =
    (r.source === 'saved') ? r.save_name : (r.property_name || r.address || '');

  _loading = false;
  markClean();
  updateSavePortfolioLink();
  updateEnergyCosts();
  saveFormState();

  document.getElementById('selected-building-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el && val != null && val !== '') el.value = val;
}

// ── SAVE-TO-PORTFOLIO LINK ────────────────────────────────────────────────────
function updateSavePortfolioLink() {
  const wrap = document.getElementById('save-to-portfolio-wrap');
  const topWrap = document.getElementById('top-save-to-portfolio-wrap');
  const nameEl = document.getElementById('save-current-name');
  if (currentSaveName) {
    if (wrap) wrap.classList.add('hidden');
    if (topWrap) topWrap.classList.add('hidden');
    if (nameEl) nameEl.textContent = `In Portfolio as: "${currentSaveName}"`;
  } else if (currentBuildingData) {
    if (wrap) wrap.classList.remove('hidden');
    if (topWrap) topWrap.classList.remove('hidden');
    if (nameEl) nameEl.textContent = '';
  } else {
    if (wrap) wrap.classList.add('hidden');
    if (topWrap) topWrap.classList.add('hidden');
    if (nameEl) nameEl.textContent = '';
  }
}

document.getElementById('save-to-portfolio-link').addEventListener('click', e => {
  e.preventDefault();
  openSaveModal();
});

document.getElementById('top-save-to-portfolio-link').addEventListener('click', e => {
  e.preventDefault();
  openSaveModal();
});

// ── CALCULATE → navigate to /calculate ───────────────────────────────────────
document.getElementById('calculate-btn').addEventListener('click', runCalculationAndNavigate);
document.getElementById('clear-btn').addEventListener('click', clearAll);
document.getElementById('top-calculate-btn').addEventListener('click', runCalculationAndNavigate);
document.getElementById('top-clear-btn').addEventListener('click', clearAll);

async function runCalculationAndNavigate() {
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

  // Save current form state so Calculate page can read it
  saveFormState();

  // Navigate to Calculate page (will recalculate there)
  window.location.href = '/calculate';
}

function getVal(id) {
  const v = parseFloat(document.getElementById(id)?.value);
  return isNaN(v) ? null : v;
}

// ── CLEAR ─────────────────────────────────────────────────────────────────────
function clearAll() {
  _loading = true;
  ['elec','gas','steam','fo2','fo4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');
  document.getElementById('selected-building-section').classList.add('hidden');
  document.getElementById('bldg-info-grid').innerHTML = '';
  const container = document.getElementById('occupancy-groups');
  container.innerHTML = '';
  occRowCount = 0;
  _loading = false;
  addOccRow();
  currentSaveName    = null;
  currentBuildingData = null;
  isDirty            = false;
  updateActiveBuildingNav();
  updateSavePortfolioLink();
  updateEnergyCosts();
  clearFormState();
}

// ── SAVE MODAL ────────────────────────────────────────────────────────────────
document.getElementById('save-modal-close').addEventListener('click', closeSaveModal);
document.getElementById('save-modal-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeSaveModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSaveModal(); });

function openSaveModal() {
  const body = document.getElementById('save-modal-body');
  document.getElementById('save-modal-title').textContent = 'Save Building to Portfolio';
  if (currentSaveName) {
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
    document.getElementById('overwrite-confirm-btn').addEventListener('click', () => doSave(currentSaveName, true));
    document.getElementById('save-as-btn').addEventListener('click', saveAsNew);
    document.getElementById('save-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveAsNew(); });
  } else {
    body.innerHTML = `
      <div class="save-option">
        <label class="input-label" for="save-name-input">Building Name in Portfolio:</label>
        <div class="save-input-row">
          <input type="text" class="form-input" id="save-name-input" placeholder="Enter a name…" autocomplete="off" />
          <button class="btn btn-primary" id="save-as-btn">Save</button>
        </div>
        <div id="save-name-error" class="save-name-error hidden"></div>
      </div>
    `;
    document.getElementById('save-as-btn').addEventListener('click', saveAsNew);
    document.getElementById('save-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveAsNew(); });
  }
  document.getElementById('save-modal-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('save-name-input')?.focus(), 50);
}

function saveAsNew() {
  const nameInput = document.getElementById('save-name-input');
  const name = (nameInput?.value || '').trim();
  if (!name) { showSaveNameError('Please enter a name.'); nameInput?.focus(); return; }
  doSave(name, false);
}

function closeSaveModal() {
  document.getElementById('save-modal-backdrop').classList.add('hidden');
}

function showSaveNameError(msg) {
  const el = document.getElementById('save-name-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
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
      showSaveNameError(
        data.error === 'name_exists'
          ? 'That name is already taken — please choose a different name.'
          : (data.error || 'Save failed. Please try again.')
      );
      return false;
    }
    currentSaveName = saveName;
    markClean();
    updateSavePortfolioLink();
    saveFormState();
    closeSaveModal();
    showSaveToast(`Saved as "${saveName}"`);
    return true;
  } catch (e) {
    showSaveNameError('Network error. Please try again.');
    return false;
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
    electricity_kwh:   getVal('elec'),
    natural_gas_therms: getVal('gas'),
    district_steam_mlb: getVal('steam'),
    fuel_oil_2_gal:    getVal('fo2'),
    fuel_oil_4_gal:    getVal('fo4'),
    occupancy_groups:  getOccupancyGroups(),
  };
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

// ── Calculate nav link intercept ──────────────────────────────────────────────
document.getElementById('calc-nav-link')?.addEventListener('click', e => {
  if (e.currentTarget.classList.contains('nav-link-disabled')) {
    e.preventDefault();
  }
});
document.getElementById('manage-nav-btn')?.addEventListener('click', e => {
  if (e.currentTarget.classList.contains('nav-link-disabled')) {
    e.preventDefault();
  }
});

// ── Nav dropdown ──────────────────────────────────────────────────────────────
(function() {
  var dd = document.getElementById('manage-nav-dropdown');
  var menu = document.getElementById('manage-nav-menu');
  if (!dd || !menu) return;
  var timer = null;
  dd.addEventListener('mouseenter', function() {
    if (dd.classList.contains('disabled')) return;
    if (timer) { clearTimeout(timer); timer = null; }
    menu.classList.add('open'); dd.classList.add('open');
  });
  dd.addEventListener('mouseleave', function() {
    timer = setTimeout(function() { menu.classList.remove('open'); dd.classList.remove('open'); }, 1000);
  });
})();

// ── FORMATTING HELPERS ─────────────────────────────────────────────────────────
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtDollars(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function esc(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── INIT ───────────────────────────────────────────────────────────────────────
(async function init() {
  await loadEnergyPrices();
  const restored = restoreFormState();
  // If no named portfolio building is active, start with a clean form
  if (!restored || !currentSaveName) {
    clearAll();
  } else {
    updateEnergyCosts();
  }

  document.getElementById('add-occ-btn').addEventListener('click', () => {
    const count = document.querySelectorAll('#occupancy-groups .occ-row').length;
    if (count < 4) { addOccRow(); markDirty(); }
  });

  ['elec','gas','steam','fo2','fo4'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => { markDirty(); updateEnergyCosts(); });
  });

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
        'Stop the app and run <code>python app.py --reimport</code> to download a fresh copy.';
      msg.classList.remove('hidden');
    }
  } catch (e) { /* ignore */ }
})();
