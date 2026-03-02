/* Calculate Result — Frontend Logic */
'use strict';

const SESSION_KEY = 'll97_calc_state';
const ACTIVE_KEY  = 'll97_active';

// ── INIT ───────────────────────────────────────────────────────────────────────
(async function init() {
  const state = readState();

  // Need at least form data + occupancy to calculate; saveName not required
  const hasData = state && state.form && state.occRows && state.occRows.length > 0;
  if (!hasData) {
    document.getElementById('cr-loading').classList.add('hidden');
    document.getElementById('cr-no-building').classList.remove('hidden');
    return;
  }

  const isSaved = !!state.saveName;

  // Restore active building chip and nav state
  if (isSaved) {
    renderActiveBuildingChip(state);
    syncNavState(state.saveName);
  }

  // Run baseline calculation
  try {
    const payload = buildPayload(state);
    if (!payload) {
      throw new Error('Missing energy or occupancy data. Please go back to Select Building.');
    }

    const resp = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Calculation error.');

    document.getElementById('cr-loading').classList.add('hidden');
    document.getElementById('cr-main').classList.remove('hidden');

    renderBuildingSummary(state);
    renderBaselineTitle(state);
    renderPeriods(data.results, 'cr-periods-grid');

    // Show save CTA for unsaved buildings; hide RP button
    if (!isSaved) {
      document.getElementById('cr-rp-btn').classList.add('hidden');
      document.getElementById('cr-unsaved-banner').classList.remove('hidden');
    }

    // Check for selected scenario (saved buildings only)
    if (isSaved) {
      try {
        const bResp = await fetch(`/api/saved-buildings/${encodeURIComponent(state.saveName)}`);
        if (bResp.ok) {
          const bData = await bResp.json();
          const building = bData.building;
          if (building.selected_scenario_id) {
            await renderScenarioCompliance(state, building.selected_scenario_id, building.year_ending);
          }
        }
      } catch (e) { /* non-fatal */ }
    }

  } catch (e) {
    document.getElementById('cr-loading').classList.add('hidden');
    const errEl = document.getElementById('cr-error');
    errEl.textContent = e.message || 'Calculation failed.';
    errEl.classList.remove('hidden');
    document.getElementById('cr-main').classList.remove('hidden');
    renderBuildingSummary(state);
  }
})();

function readState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function buildPayload(state) {
  if (!state.form) return null;
  const occ = (state.occRows || [])
    .filter(r => r.type && parseFloat(r.area) > 0)
    .map(r => ({ property_type: r.type, floor_area: parseFloat(r.area) }));
  if (!occ.length) return null;
  const hasEnergy = ['elec','gas','steam','fo2','fo4'].some(k => parseFloat(state.form[k]) > 0);
  if (!hasEnergy) return null;
  return {
    electricity_kwh:      parseFloat(state.form.elec)  || 0,
    natural_gas_therms:   parseFloat(state.form.gas)   || 0,
    district_steam_mlb:   parseFloat(state.form.steam) || 0,
    fuel_oil_2_gal:       parseFloat(state.form.fo2)   || 0,
    fuel_oil_4_gal:       parseFloat(state.form.fo4)   || 0,
    occupancy_groups:     occ,
  };
}

// ── BUILDING SUMMARY ──────────────────────────────────────────────────────────
function renderBuildingSummary(state) {
  const bd = state.buildingData || {};
  const line1El = document.getElementById('cr-summary-line1');
  const line2El = document.getElementById('cr-summary-line2');
  const popupEl = document.getElementById('cr-summary-popup');
  if (!line1El) return;

  const name = state.saveName || bd.property_name || '—';
  const parts1 = [
    `<span class="cr-sum-name">${esc(name)}</span>`,
    bd.address ? `<span class="cr-sum-field">${esc(bd.address)}</span>` : null,
    bd.borough ? `<span class="cr-sum-field">${esc(bd.borough)}</span>` : null,
    bd.postcode ? `<span class="cr-sum-field">${esc(bd.postcode)}</span>` : null,
  ].filter(Boolean);
  line1El.innerHTML = parts1.join('<span class="cr-sum-sep"> · </span>');

  const parts2 = [];
  if (bd.bbl)  parts2.push(`<span class="cr-sum-label">BBL</span> <span class="cr-sum-val">${esc(bd.bbl)}</span>`);
  if (bd.bin)  parts2.push(`<span class="cr-sum-label">BIN</span> <span class="cr-sum-val">${esc(bd.bin)}</span>`);
  line2El.innerHTML = parts2.join('<span class="cr-sum-sep"> · </span>');

  // Popup
  const occRows = (state.occRows || []).filter(r => r.type && parseFloat(r.area) > 0);
  const form = state.form || {};
  let popup = `<div class="cr-popup-title">${esc(name)}</div>`;
  if (bd.address) popup += `<div>${esc(bd.address)}${bd.borough ? ', ' + esc(bd.borough) : ''}${bd.postcode ? ' ' + esc(bd.postcode) : ''}</div>`;
  if (bd.gross_floor_area) popup += `<div><strong>${fmtNum(bd.gross_floor_area)}</strong> sq ft gross floor area</div>`;
  if (occRows.length) {
    popup += `<div class="cr-popup-section">Occupancy Types</div>`;
    occRows.forEach(r => { popup += `<div>${esc(r.type)}: ${fmtNum(parseFloat(r.area))} sf</div>`; });
  }
  const fuels = [
    { key: 'elec', label: 'Electricity', unit: 'kWh' },
    { key: 'gas',  label: 'Natural Gas', unit: 'therms' },
    { key: 'steam',label: 'District Steam', unit: 'Mlb' },
    { key: 'fo2',  label: '#2 Fuel Oil', unit: 'gal' },
    { key: 'fo4',  label: '#4 Fuel Oil', unit: 'gal' },
  ].filter(f => parseFloat(form[f.key]) > 0);
  if (fuels.length) {
    popup += `<div class="cr-popup-section">Annual Energy</div>`;
    fuels.forEach(f => { popup += `<div>${esc(f.label)}: <strong>${fmtNum(parseFloat(form[f.key]))}</strong> ${f.unit}</div>`; });
  }
  popupEl.innerHTML = popup;
}

function renderBaselineTitle(state) {
  const bd = state.buildingData || {};
  const titleEl = document.getElementById('cr-baseline-title');
  if (!titleEl) return;
  let dataYear = '';
  if (bd.year_ending) {
    dataYear = String(bd.year_ending).substring(0, 4);
  }
  titleEl.textContent = dataYear
    ? `LL97 Compliance by Period – Based Upon ${dataYear} Usage`
    : 'LL97 Compliance by Period';
}

// ── SCENARIO COMPLIANCE ───────────────────────────────────────────────────────
async function renderScenarioCompliance(state, scenarioId, yearEnding) {
  const payload = buildPayload(state);
  if (!payload) return;
  payload.scenario_id = scenarioId;

  try {
    const resp = await fetch('/api/scenario-period-compliance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) return;

    const card = document.getElementById('cr-scenario-card');
    const descEl = document.getElementById('cr-scenario-desc');
    if (descEl && data.scenario_name) {
      descEl.textContent = `"${data.scenario_name}" applied.`;
    }

    renderPeriods(data.results, 'cr-scenario-grid');

    // Link Timeline to show the selected scenario
    const timelineLink = document.getElementById('cr-timeline-link');
    if (timelineLink) {
      try {
        localStorage.setItem('ll97_timeline_scenario_id', String(scenarioId));
      } catch (e) { /* ignore */ }
    }

    card.classList.remove('hidden');
  } catch (e) { /* non-fatal */ }
}

// ── RENDER PERIODS ────────────────────────────────────────────────────────────
function renderPeriods(results, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = '';
  const periods = window.COMPLIANCE_PERIODS || [];
  periods.forEach(period => {
    const r = results[period];
    if (!r) return;
    const isZero = r.limit === 0;
    const compliant = r.compliant;
    const statusClass = isZero ? 'zero-limit' : (compliant ? 'compliant' : 'non-compliant');
    const statusText  = isZero ? '2050 Target: 0' : (compliant ? '✓ Compliant' : '✗ Non-Compliant');
    const col = document.createElement('div');
    col.className = `period-col ${statusClass}`;
    const pct = r.limit > 0 ? Math.min(100, (r.emissions / r.limit) * 100) : 0;
    const barClass = compliant ? 'ok' : 'over';
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
      </div>`;
    grid.appendChild(col);
  });
}

// ── SAVE UNSAVED BUILDING ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const saveBtn = document.getElementById('cr-save-btn');
  const nameInput = document.getElementById('cr-save-name-input');
  if (!saveBtn) return;
  const doSave = async () => {
    const name = (nameInput?.value || '').trim();
    const errEl = document.getElementById('cr-save-error');
    errEl.classList.add('hidden');
    if (!name) {
      errEl.textContent = 'Please enter a name.';
      errEl.classList.remove('hidden');
      nameInput?.focus();
      return;
    }
    const state = readState();
    const bd = state.buildingData || {};
    const form = state.form || {};
    const building = {
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
      electricity_kwh:      parseFloat(form.elec)  || 0,
      natural_gas_therms:   parseFloat(form.gas)   || 0,
      district_steam_mlb:   parseFloat(form.steam) || 0,
      fuel_oil_2_gal:       parseFloat(form.fo2)   || 0,
      fuel_oil_4_gal:       parseFloat(form.fo4)   || 0,
      occupancy_groups: (state.occRows || [])
        .filter(r => r.type && parseFloat(r.area) > 0)
        .map(r => ({ property_type: r.type, floor_area: parseFloat(r.area) })),
    };
    try {
      const resp = await fetch('/api/save-building', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save_name: name, overwrite: false, building }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        errEl.textContent = data.error === 'name_exists'
          ? 'That name is already taken — please choose a different name.'
          : (data.error || 'Save failed. Please try again.');
        errEl.classList.remove('hidden');
        return;
      }
      // Update localStorage with new saveName
      const updated = { ...state, saveName: name };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(updated)); } catch(e) {}
      try { localStorage.setItem(ACTIVE_KEY, JSON.stringify({ saveName: name })); } catch(e) {}
      // Update UI: hide banner, show RP button, enable nav
      document.getElementById('cr-unsaved-banner').classList.add('hidden');
      document.getElementById('cr-rp-btn').classList.remove('hidden');
      syncNavState(name);
      renderActiveBuildingChip(updated);
    } catch (e) {
      errEl.textContent = 'Network error. Please try again.';
      errEl.classList.remove('hidden');
    }
  };
  saveBtn.addEventListener('click', doSave);
  nameInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
});

// ── ACTIVE BUILDING CHIP ──────────────────────────────────────────────────────
function renderActiveBuildingChip(state) {
  const nav = document.getElementById('active-building-nav');
  if (!nav || !state.saveName) return;
  const bd = state.buildingData || {};
  let tipHtml = `<div class="abt-name">${esc(bd.property_name || state.saveName)}</div>`;
  if (bd.address) tipHtml += `<div class="abt-row">${esc(bd.address)}${bd.borough ? ', ' + esc(bd.borough) : ''}${bd.postcode ? ' ' + esc(bd.postcode) : ''}</div>`;
  if (bd.gross_floor_area) tipHtml += `<div class="abt-row"><strong>${fmtNum(bd.gross_floor_area)}</strong> sq ft</div>`;
  const svgB =
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
    `<span class="active-building-chip">${svgB}<span class="active-building-chip-name">${esc(state.saveName)}</span></span>`+
    `<div class="active-building-tooltip">${tipHtml}</div>`+
    `</div>`;
}

function syncNavState(saveName) {
  if (!saveName) return;
  // Calculate link is already active on this page
  const dd = document.getElementById('manage-nav-dropdown');
  const btn = document.getElementById('manage-nav-btn');
  if (dd) { dd.classList.remove('disabled'); dd.removeAttribute('title'); }
  if (btn) btn.classList.remove('nav-link-disabled');
}

// ── FORMATTING ─────────────────────────────────────────────────────────────────
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtTons(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtKgSf(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
function fmtDollars(n) { return n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function esc(str) { return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
