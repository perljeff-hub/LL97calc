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
    const resp = await fetch('/api/portfolio');
    const data = await resp.json();
    document.getElementById('pf-loading').classList.add('hidden');
    const buildings = data.buildings || [];
    if (!buildings.length) {
      document.getElementById('pf-empty').classList.remove('hidden');
      return;
    }
    renderPortfolio(buildings);
  } catch (e) {
    document.getElementById('pf-loading').classList.add('hidden');
    const errEl = document.getElementById('pf-error');
    errEl.textContent = 'Failed to load portfolio: ' + e.message;
    errEl.classList.remove('hidden');
  }
}

function renderPortfolio(buildings) {
  const content = document.getElementById('pf-content');
  content.innerHTML = '';
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

  // Header row
  const header = document.createElement('div');
  header.className = 'pf-card-header';
  header.innerHTML = `
    <div class="pf-card-title">
      <span class="pf-bldg-name">${esc(b.save_name)}</span>
      ${b.property_name ? `<span class="pf-bldg-prop">${esc(b.property_name)}</span>` : ''}
    </div>
    <div class="pf-card-meta">
      ${b.address ? `<span>${esc(b.address)}${b.borough ? ', ' + esc(b.borough) : ''}${b.postcode ? ' ' + esc(b.postcode) : ''}</span>` : ''}
      ${b.gross_floor_area ? `<span>${fmtNum(b.gross_floor_area)} sf</span>` : ''}
      ${b.year_ending ? `<span>Data year: ${String(b.year_ending).substring(0,4)}</span>` : ''}
    </div>
    <a href="#" class="btn btn-primary btn-sm pf-calc-link" data-name="${esc(b.save_name)}">Open in Calculate →</a>
  `;
  card.appendChild(header);

  // Compliance table
  if (hasCompliance) {
    const tableWrap = document.createElement('div');
    tableWrap.className = 'pf-compliance-wrap';

    const table = document.createElement('table');
    table.className = 'pf-compliance-table';

    // Header
    let thead = `<thead><tr><th>Period</th><th>Baseline Annual Fine</th>`;
    if (hasScenario) {
      thead += `<th>${esc(b.selected_scenario_name || 'Selected Scenario')}<br><small>Annual Fine</small></th>`;
    }
    thead += `</tr></thead>`;
    table.innerHTML = thead;

    const tbody = document.createElement('tbody');
    COMPLIANCE_PERIODS.forEach(period => {
      const base = b.compliance_cache[period];
      const scen = hasScenario ? b.selected_scenario_compliance[period] : null;
      if (!base) return;

      const tr = document.createElement('tr');
      tr.className = base.compliant ? 'pf-compliant' : 'pf-non-compliant';

      const baseLabel = base.penalty === 0 ? '<span class="pf-fine-ok">$0</span>' : `<span class="pf-fine-bad">${fmtDollars(base.penalty)}/yr</span>`;

      let scenCell = '';
      if (hasScenario && scen) {
        const scenLabel = scen.penalty === 0
          ? '<span class="pf-fine-ok">$0</span>'
          : `<span class="${scen.penalty < base.penalty ? 'pf-fine-better' : 'pf-fine-bad'}">${fmtDollars(scen.penalty)}/yr</span>`;
        scenCell = `<td>${scenLabel}</td>`;
      }

      tr.innerHTML = `
        <td class="pf-period-label">${esc(PERIOD_LABELS[period] || period)}</td>
        <td>${baseLabel}</td>
        ${scenCell}
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    card.appendChild(tableWrap);
  } else {
    const noData = document.createElement('p');
    noData.className = 'pf-no-data';
    noData.textContent = 'Compliance data not yet calculated. Open in Calculate to generate.';
    card.appendChild(noData);
  }

  if (hasScenario) {
    const scenNote = document.createElement('p');
    scenNote.className = 'pf-scenario-note';
    scenNote.innerHTML = `Selected scenario: <strong>${esc(b.selected_scenario_name || 'Unnamed')}</strong> — set on Reduction Plan page.`;
    card.appendChild(scenNote);
  }

  // Wire up the "Open in Calculate" link
  card.querySelector('.pf-calc-link').addEventListener('click', e => {
    e.preventDefault();
    openBuildingInCalculate(b.save_name);
  });

  return card;
}

async function openBuildingInCalculate(saveName) {
  try {
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
    // Store selected scenario for Timeline
    if (b.selected_scenario_id) {
      localStorage.setItem('ll97_timeline_scenario_id', String(b.selected_scenario_id));
    }
    window.location.href = '/calculate';
  } catch (e) {
    alert('Could not load building: ' + e.message);
  }
}

function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtDollars(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function esc(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
