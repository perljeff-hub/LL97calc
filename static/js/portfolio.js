/* Portfolio — Frontend Logic */
'use strict';

const SESSION_KEY = 'll97_calc_state';
const ACTIVE_KEY  = 'll97_active';
const COMPLIANCE_PERIODS = ['2024_2029','2030_2034','2035_2039','2040_2049','2050_plus'];
const PERIOD_LABELS = {
  '2024_2029': '2024–2029',
  '2030_2034': '2030–2034',
  '2035_2039': '2035–2039',
  '2040_2049': '2040–2049',
  '2050_plus': '2050+',
};

document.addEventListener('DOMContentLoaded', function() {
  // Add a Building buttons
  document.getElementById('pf-add-btn').addEventListener('click', addBuilding);
  const emptyBtn = document.getElementById('pf-add-btn-empty');
  if (emptyBtn) emptyBtn.addEventListener('click', addBuilding);

  loadPortfolio();
});

const PF_SESSION_KEY = 'pf_session_refreshed';

function addBuilding() {
  // Clear active building and navigate to Select Building
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem('ll97_timeline_scenario_id');
  } catch (e) { /* ignore */ }
  window.location.href = '/select-building';
}

async function loadPortfolio() {
  try {
    // On first visit in a session, force-recompute all compliance caches
    // so the portfolio reflects current building data and GHG factor settings
    if (!sessionStorage.getItem(PF_SESSION_KEY)) {
      sessionStorage.setItem(PF_SESSION_KEY, '1');
      await fetch('/api/portfolio/recalculate-all', { method: 'POST' });
    }
    const resp = await fetch('/api/portfolio');
    const data = await resp.json();
    document.getElementById('pf-loading').classList.add('hidden');
    document.getElementById('pf-header-row').classList.remove('hidden');
    const buildings = data.buildings || [];
    if (!buildings.length) {
      document.getElementById('pf-empty').classList.remove('hidden');
      return;
    }
    renderPortfolio(buildings);
  } catch (e) {
    document.getElementById('pf-loading').classList.add('hidden');
    document.getElementById('pf-header-row').classList.remove('hidden');
    const errEl = document.getElementById('pf-error');
    errEl.textContent = 'Failed to load portfolio: ' + e.message;
    errEl.classList.remove('hidden');
  }
}

function renderPortfolio(buildings) {
  const content = document.getElementById('pf-content');
  content.innerHTML = '';
  buildings.sort((a, b) =>
    String(a.save_name || '').localeCompare(String(b.save_name || ''), 'en', { numeric: true, sensitivity: 'base' })
  );
  buildings.forEach(b => {
    const card = buildBuildingCard(b);
    content.appendChild(card);
  });
  content.classList.remove('hidden');
}

function buildBuildingCard(b) {
  const card = document.createElement('div');
  card.className = 'pf-building-card card';

  const hasCompliance = b.compliance_cache && typeof b.compliance_cache === 'object';
  const hasScenario   = b.selected_scenario_compliance && typeof b.selected_scenario_compliance === 'object';

  // Compact header: name + inline meta + Open button
  const metaParts = [];
  const addrParts = [b.address, b.borough, b.postcode].filter(Boolean);
  if (addrParts.length) metaParts.push(esc(addrParts.join(', ')));
  if (b.gross_floor_area) metaParts.push(fmtNum(b.gross_floor_area) + ' sf');
  if (b.year_ending) metaParts.push('Data: ' + String(b.year_ending).substring(0, 4));

  const header = document.createElement('div');
  header.className = 'pf-card-header';
  header.innerHTML = `
    <div class="pf-card-identity">
      <span class="pf-bldg-name">${esc(b.save_name)}</span>
      <button class="pf-edit-btn" title="Rename or delete building" data-name="${esc(b.save_name)}" aria-label="Edit building">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H3v-2L11.5 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </button>
      ${b.property_name && b.property_name !== b.save_name ? `<span class="pf-bldg-prop">${esc(b.property_name)}</span>` : ''}
      ${metaParts.length ? `<span class="pf-bldg-meta">${metaParts.join(' · ')}</span>` : ''}
    </div>
    <div class="pf-card-actions">
      <a href="#" class="btn btn-ghost btn-sm pf-calc-link" data-name="${esc(b.save_name)}">Calculate Compliance</a>
      <a href="#" class="btn btn-ghost btn-sm pf-manage-link" data-name="${esc(b.save_name)}">Manage Reduction Plans</a>
    </div>
  `;
  card.appendChild(header);

  if (hasCompliance) {
    // Transposed table: periods as columns, Baseline + Scenario as rows
    const tableWrap = document.createElement('div');
    tableWrap.className = 'pf-compliance-wrap';

    const table = document.createElement('table');
    table.className = 'pf-compliance-table';

    // thead — period labels as columns
    let headHtml = '<thead><tr><th class="pf-row-th"></th>';
    COMPLIANCE_PERIODS.forEach(p => {
      headHtml += `<th class="pf-period-th">${PERIOD_LABELS[p]}</th>`;
    });
    headHtml += '</tr></thead>';
    table.innerHTML = headHtml;

    const tbody = document.createElement('tbody');

    // Baseline row
    const baseRow = document.createElement('tr');
    baseRow.className = 'pf-baseline-row';
    let baseHtml = '<td class="pf-row-label">Baseline</td>';
    COMPLIANCE_PERIODS.forEach(period => {
      const base = b.compliance_cache[period];
      if (!base) { baseHtml += '<td>—</td>'; return; }
      const cls = base.penalty == null ? '' : base.penalty === 0 ? 'pf-fine-ok' : 'pf-fine-bad';
      baseHtml += `<td class="${cls}">${base.penalty == null ? '—' : base.penalty === 0 ? '$0' : fmtDollars(base.penalty) + '/yr'}</td>`;
    });
    baseRow.innerHTML = baseHtml;
    tbody.appendChild(baseRow);

    // Scenario row (only if a selected scenario exists)
    if (hasScenario) {
      const scenRow = document.createElement('tr');
      scenRow.className = 'pf-scen-row';
      const scenLabel = esc(b.selected_scenario_name || 'Selected Scenario');
      let scenHtml = `<td class="pf-row-label pf-scen-label">&#x2605;&nbsp;${scenLabel}</td>`;
      COMPLIANCE_PERIODS.forEach(period => {
        const base = b.compliance_cache[period];
        const scen = b.selected_scenario_compliance[period];
        if (!scen) { scenHtml += '<td>—</td>'; return; }
        let cls, text;
        if (scen.penalty == null) {
          cls = ''; text = '—';
        } else if (scen.penalty === 0) {
          cls = 'pf-fine-ok'; text = '$0';
        } else if (base && scen.penalty < base.penalty) {
          cls = 'pf-fine-better'; text = fmtDollars(scen.penalty) + '/yr';
        } else {
          cls = 'pf-fine-bad'; text = fmtDollars(scen.penalty) + '/yr';
        }
        scenHtml += `<td class="${cls}">${text}</td>`;
      });
      scenRow.innerHTML = scenHtml;
      tbody.appendChild(scenRow);
    }

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);
  } else {
    const noData = document.createElement('p');
    noData.className = 'pf-no-data';
    noData.textContent = 'No compliance data. Open in Calculate to generate.';
    card.appendChild(noData);
  }

  // Wire up card action buttons
  card.querySelector('.pf-calc-link').addEventListener('click', e => {
    e.preventDefault();
    openBuildingInCalculate(b.save_name);
  });
  card.querySelector('.pf-manage-link').addEventListener('click', e => {
    e.preventDefault();
    openBuildingInTimeline(b.save_name);
  });
  card.querySelector('.pf-edit-btn').addEventListener('click', e => {
    e.preventDefault();
    openEditModal(b.save_name);
  });

  return card;
}

// ── EDIT MODAL ────────────────────────────────────────────────────────────────
let _editTarget = null;  // save_name of building being edited

function openEditModal(saveName) {
  _editTarget = saveName;
  document.getElementById('pf-edit-desc').textContent = saveName;
  document.getElementById('pf-edit-name-input').value = saveName;
  document.getElementById('pf-edit-error').classList.add('hidden');
  document.getElementById('pf-edit-confirm-section').classList.add('hidden');
  document.getElementById('pf-edit-delete-btn').classList.remove('hidden');
  document.getElementById('pf-edit-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('pf-edit-name-input').focus(), 50);
}

function closeEditModal() {
  document.getElementById('pf-edit-backdrop').classList.add('hidden');
  _editTarget = null;
}

async function doRename() {
  if (!_editTarget) return;
  const newName = document.getElementById('pf-edit-name-input').value.trim();
  const errEl   = document.getElementById('pf-edit-error');
  if (!newName) {
    errEl.textContent = 'Please enter a name.';
    errEl.classList.remove('hidden');
    return;
  }
  try {
    const resp = await fetch('/api/saved-buildings/' + encodeURIComponent(_editTarget) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_name: newName }),
    });
    const json = await resp.json();
    if (!resp.ok) { errEl.textContent = json.error || 'Rename failed.'; errEl.classList.remove('hidden'); return; }
    // If the renamed building is the active one, update localStorage
    try {
      const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
      if (active && active.saveName === _editTarget) {
        active.saveName = newName;
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
        const state = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (state) { state.saveName = newName; if (state.buildingData) state.buildingData.save_name = newName; localStorage.setItem(SESSION_KEY, JSON.stringify(state)); }
      }
    } catch (e) { /* ignore */ }
    closeEditModal();
    sessionStorage.removeItem(PF_SESSION_KEY);
    loadPortfolio();
  } catch (e) {
    errEl.textContent = 'Rename failed. Please try again.';
    errEl.classList.remove('hidden');
  }
}

async function doDelete() {
  if (!_editTarget) return;
  const errEl = document.getElementById('pf-edit-error');
  try {
    const resp = await fetch('/api/saved-buildings/' + encodeURIComponent(_editTarget), { method: 'DELETE' });
    const json = await resp.json();
    if (!resp.ok) { errEl.textContent = json.error || 'Delete failed.'; errEl.classList.remove('hidden'); return; }
    // Clear active building from localStorage if it was the deleted one
    try {
      const active = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null');
      if (active && active.saveName === _editTarget) {
        localStorage.removeItem(ACTIVE_KEY);
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem('ll97_timeline_scenario_id');
      }
    } catch (e) { /* ignore */ }
    closeEditModal();
    sessionStorage.removeItem(PF_SESSION_KEY);
    loadPortfolio();
  } catch (e) {
    errEl.textContent = 'Delete failed. Please try again.';
    errEl.classList.remove('hidden');
  }
}

// Edit modal event wiring (runs once at page load)
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('pf-edit-close').addEventListener('click', closeEditModal);
  document.getElementById('pf-edit-backdrop').addEventListener('click', e => { if (e.target === e.currentTarget) closeEditModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeEditModal(); });
  document.getElementById('pf-edit-rename-btn').addEventListener('click', doRename);
  document.getElementById('pf-edit-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doRename(); });
  document.getElementById('pf-edit-delete-btn').addEventListener('click', () => {
    document.getElementById('pf-edit-confirm-section').classList.remove('hidden');
    document.getElementById('pf-edit-delete-btn').classList.add('hidden');
  });
  document.getElementById('pf-edit-confirm-delete-btn').addEventListener('click', doDelete);
  document.getElementById('pf-edit-cancel-delete-btn').addEventListener('click', () => {
    document.getElementById('pf-edit-confirm-section').classList.add('hidden');
    document.getElementById('pf-edit-delete-btn').classList.remove('hidden');
  });
});

async function loadBuildingToLocalStorage(saveName) {
  const resp = await fetch('/api/saved-buildings/' + encodeURIComponent(saveName));
  if (!resp.ok) throw new Error('Building not found');
  const data = await resp.json();
  const b = data.building;
  const occ = (b.occupancy_groups || []).map(g => ({
    type: g.property_type,
    area: String(g.floor_area),
  }));
  const buildingData = {
    source:            'saved',
    save_name:         b.save_name,
    bbl:               b.source_bbl || '',
    bin:               b.source_bin || '',
    property_name:     b.property_name || '',
    address:           b.address || '',
    borough:           b.borough || '',
    postcode:          b.postcode || '',
    year_ending:       b.year_ending || '',
    gross_floor_area:  b.gross_floor_area || null,
    energy_star_score: b.energy_star_score || '',
    electricity_kwh:   b.electricity_kwh || null,
    natural_gas_therms: b.natural_gas_therms || null,
    district_steam_mlb: b.district_steam_mlb || null,
    fuel_oil_2_gal:    b.fuel_oil_2_gal || null,
    fuel_oil_4_gal:    b.fuel_oil_4_gal || null,
    occupancy_groups:  b.occupancy_groups || [],
  };
  const state = {
    saveName:     b.save_name,
    buildingData: buildingData,
    isDirty:      false,
    form: {
      elec:  String(b.electricity_kwh    || ''),
      gas:   String(b.natural_gas_therms  || ''),
      steam: String(b.district_steam_mlb  || ''),
      fo2:   String(b.fuel_oil_2_gal      || ''),
      fo4:   String(b.fuel_oil_4_gal      || ''),
    },
    occRows: occ,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(state));
  localStorage.setItem(ACTIVE_KEY, JSON.stringify({ saveName: b.save_name }));
  if (b.selected_scenario_id) {
    localStorage.setItem('ll97_timeline_scenario_id', String(b.selected_scenario_id));
  } else {
    localStorage.removeItem('ll97_timeline_scenario_id');
  }
  return b;
}

async function openBuildingInCalculate(saveName) {
  try {
    await loadBuildingToLocalStorage(saveName);
    window.location.href = '/calculate';
  } catch (e) {
    alert('Could not load building: ' + e.message);
  }
}

async function openBuildingInTimeline(saveName) {
  try {
    await loadBuildingToLocalStorage(saveName);
    window.location.href = '/manage';
  } catch (e) {
    alert('Could not load building: ' + e.message);
  }
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtDollars(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function esc(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
