/* Building History — per-building year-over-year detail */
'use strict';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtNum(n, decimals) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals || 0,
    maximumFractionDigits: decimals == null ? 0 : decimals,
  });
}
function fmtDollars(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const FIELD_LABELS = {
  bbl:                'BBL',
  bin:                'BIN',
  property_name:      'Property Name',
  address:            'Address',
  borough:            'Borough',
  postcode:           'Zip Code',
  gross_floor_area:   'Gross Floor Area (sq ft)',
  occupancy_types:    'Occupancy Type(s)',
  energy_star_score:  'Energy Star Score',
  electricity_kwh:    'Electricity (kWh)',
  natural_gas_therms: 'Natural Gas (therms)',
  district_steam_mlb: 'District Steam (Mlb)',
  fuel_oil_2_gal:     '#2 Fuel Oil (gal)',
  fuel_oil_4_gal:     '#4 Fuel Oil (gal)',
  reported_ghg:       'Reported GHG (tCO₂e)',
};

// Trend fields: key → true = higher is better (green↑/red↓), false = lower is better (red↑/green↓)
const TREND_FIELDS = {
  energy_star_score:  true,
  electricity_kwh:    false,
  natural_gas_therms: false,
  district_steam_mlb: false,
  fuel_oil_2_gal:     false,
  fuel_oil_4_gal:     false,
};

function trendArrow(curr, prev, higherIsBetter) {
  if (curr == null || prev == null || curr === prev) return '';
  const up   = curr > prev;
  const good = higherIsBetter ? up : !up;
  const cls  = good ? 'bh-trend-good' : 'bh-trend-bad';
  const sym  = up ? '▲' : '▼';
  return ` <span class="bh-trend ${cls}" title="${up ? '+' : '−'}${fmtNum(Math.abs(curr - prev), 1)} vs prior year">${sym}</span>`;
}

function formatFieldValue(key, val) {
  if (val == null) return '—';
  if (key === 'gross_floor_area' || key === 'electricity_kwh') return fmtNum(val, 0);
  if (key === 'natural_gas_therms' || key === 'fuel_oil_2_gal' || key === 'fuel_oil_4_gal') return fmtNum(val, 1);
  if (key === 'district_steam_mlb') return fmtNum(val, 3);
  if (key === 'reported_ghg') return fmtNum(val, 1);
  return esc(String(val));
}

// Standard building SVG icon (matches calculator.js)
const _SVG_BUILDING =
  `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0">` +
  `<rect x="3" y="4" width="10" height="11" rx=".5" stroke="currentColor" stroke-width="1.5"/>` +
  `<rect x="5" y="6" width="2" height="2" rx=".3" fill="currentColor"/>` +
  `<rect x="9" y="6" width="2" height="2" rx=".3" fill="currentColor"/>` +
  `<rect x="5" y="10" width="2" height="2" rx=".3" fill="currentColor"/>` +
  `<rect x="9" y="10" width="2" height="2" rx=".3" fill="currentColor"/>` +
  `<path d="M6.5 15V12h3v3" stroke="currentColor" stroke-width="1.3" fill="none"/>` +
  `<path d="M1 4l7-3 7 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>` +
  `</svg>`;

function buildChipHtml(sn, r) {
  r = r || {};
  let tipHtml = `<div class="abt-name">${esc(r.property_name || sn)}</div>`;
  if (r.address) tipHtml += `<div class="abt-row">${esc(r.address)}${r.borough ? ', ' + esc(r.borough) : ''}</div>`;
  if (r.gross_floor_area) tipHtml += `<div class="abt-row"><strong>${Number(r.gross_floor_area).toLocaleString('en-US')}</strong> sq ft</div>`;
  if (r.energy_star_score) tipHtml += `<div class="abt-row">ENERGY STAR: <strong>${esc(String(r.energy_star_score))}</strong></div>`;
  return `<div class="active-building-chip-wrap">` +
    `<span class="active-building-chip">${_SVG_BUILDING}<span class="active-building-chip-name">${esc(sn)}</span></span>` +
    `<div class="active-building-tooltip">${tipHtml}</div>` +
    `</div>`;
}

function syncNavLinks(hasSaveName) {
  const calcLink = document.getElementById('calc-nav-link');
  const dd = document.getElementById('manage-nav-dropdown');
  const bt = document.getElementById('manage-nav-btn');
  if (hasSaveName) {
    if (calcLink) { calcLink.classList.remove('nav-link-disabled'); calcLink.removeAttribute('title'); }
    if (dd)       { dd.classList.remove('disabled'); dd.removeAttribute('title'); }
    if (bt)       { bt.classList.remove('nav-link-disabled'); }
  }
}

// Extract save_name from URL path: /building-history/<save_name>
const saveName = decodeURIComponent(window.location.pathname.replace('/building-history/', ''));

// Render chip + enable nav links from localStorage immediately (before async data loads)
function renderChipFromStorage() {
  try {
    const state = JSON.parse(localStorage.getItem('ll97_calc_state') || 'null');
    if (!state || !state.saveName) return;
    const nav = document.getElementById('active-building-nav');
    if (nav) nav.innerHTML = buildChipHtml(state.saveName, state.buildingData);
    syncNavLinks(true);
  } catch (e) { /* ignore */ }
}
renderChipFromStorage();



async function loadHistory() {
  try {
    const resp = await fetch(`/api/building-history/${encodeURIComponent(saveName)}`);
    if (!resp.ok) throw new Error('Not found');
    const data = await resp.json();
    renderPage(data);
  } catch (e) {
    document.getElementById('bh-loading').classList.add('hidden');
    const errEl = document.getElementById('bh-error');
    errEl.textContent = 'Failed to load building history. Please try again.';
    errEl.classList.remove('hidden');
  }
}

function setActiveBuilding(bldg) {
  const buildingData = {
    source: 'saved',
    save_name:          bldg.save_name,
    bbl:                bldg.source_bbl || '',
    bin:                bldg.source_bin || '',
    property_name:      bldg.property_name || '',
    address:            bldg.address || '',
    borough:            bldg.borough || '',
    postcode:           bldg.postcode || '',
    year_ending:        bldg.year_ending || '',
    gross_floor_area:   bldg.gross_floor_area || null,
    energy_star_score:  bldg.energy_star_score || '',
    electricity_kwh:    bldg.electricity_kwh || null,
    natural_gas_therms: bldg.natural_gas_therms || null,
    district_steam_mlb: bldg.district_steam_mlb || null,
    fuel_oil_2_gal:     bldg.fuel_oil_2_gal || null,
    fuel_oil_4_gal:     bldg.fuel_oil_4_gal || null,
    occupancy_groups:   bldg.occupancy_groups || [],
  };
  const occ = (bldg.occupancy_groups || []).map(g => ({ type: g.property_type, area: String(g.floor_area) }));
  const state = {
    saveName: bldg.save_name,
    buildingData: buildingData,
    isDirty: false,
    form: {
      elec:  String(bldg.electricity_kwh    || ''),
      gas:   String(bldg.natural_gas_therms  || ''),
      steam: String(bldg.district_steam_mlb  || ''),
      fo2:   String(bldg.fuel_oil_2_gal      || ''),
      fo4:   String(bldg.fuel_oil_4_gal      || ''),
    },
    occRows: occ,
  };
  localStorage.setItem('ll97_calc_state', JSON.stringify(state));
  localStorage.setItem('ll97_active', JSON.stringify({ saveName: bldg.save_name }));
  if (bldg.selected_scenario_id) {
    localStorage.setItem('ll97_timeline_scenario_id', String(bldg.selected_scenario_id));
  } else {
    localStorage.removeItem('ll97_timeline_scenario_id');
  }

  const nav = document.getElementById('active-building-nav');
  if (nav && bldg.save_name) nav.innerHTML = buildChipHtml(bldg.save_name, buildingData);
  syncNavLinks(!!bldg.save_name);
}

function renderPage(data) {
  document.getElementById('bh-loading').classList.add('hidden');

  const bldg     = data.building || {};
  const years    = data.years    || [];
  const yearData = data.year_data || {};
  const changedRows = new Set(data.changed_rows || []);

  // Set active building in localStorage and render nav chip
  setActiveBuilding(bldg);

  // Header: large text = save name; subtitle = LL84 property name + BBL + BIN from most recent year
  document.getElementById('bh-title').textContent = bldg.save_name || saveName;
  const sortedYrs = [...years].sort((a, b) => b - a);
  let ll84PropName = null, ll84Bbl = null, ll84Bin = null;
  for (const yr of sortedYrs) {
    const yd = yearData[String(yr)];
    if (yd && yd.source === 'll84' && yd.fields) {
      ll84PropName = yd.fields.property_name || null;
      ll84Bbl      = yd.fields.bbl || null;
      ll84Bin      = yd.fields.bin || null;
      break;
    }
  }
  const subtitleParts = [];
  if (ll84PropName) subtitleParts.push(ll84PropName);
  if (ll84Bbl)      subtitleParts.push('BBL: ' + ll84Bbl);
  if (ll84Bin)      subtitleParts.push('BIN: ' + ll84Bin);
  document.getElementById('bh-address').textContent = subtitleParts.join(' · ');

  const addrParts = [bldg.address, bldg.borough, bldg.postcode].filter(Boolean);
  document.getElementById('bh-address2').textContent = addrParts.join(', ');

  const table = document.getElementById('bh-table');
  let html = '<thead><tr><th class="bh-th-field">Field</th>';
  for (const yr of years) {
    html += `<th class="bh-th-year">${esc(String(yr))}</th>`;
  }
  html += '</tr></thead><tbody>';

  // Identify the most recent and second-most-recent years for trend indicators
  const latestYr = years.length > 0 ? years[years.length - 1] : null;
  const prevYr   = years.length > 1 ? years[years.length - 2] : null;

  // Summary rows (emissions + fine) at top
  html += buildSummaryRows(years, yearData, latestYr, prevYr);

  // Separator
  html += `<tr class="bh-separator-row"><td colspan="${years.length + 1}" class="bh-separator">LL84 Reported Data</td></tr>`;

  // Field rows
  for (const fk of data.field_keys || []) {
    const label    = FIELD_LABELS[fk] || fk;
    const changed  = changedRows.has(fk);
    const rowClass = changed ? ' bh-row-changed' : '';

    html += `<tr class="${rowClass}"><td class="bh-td-field">${esc(label)}</td>`;
    for (const yr of years) {
      const yd  = yearData[String(yr)];
      const val = yd && yd.fields ? yd.fields[fk] : null;
      let cell  = formatFieldValue(fk, val);
      if (yr === latestYr && fk in TREND_FIELDS) {
        const ydPrev  = prevYr != null ? yearData[String(prevYr)] : null;
        const valPrev = ydPrev && ydPrev.fields ? ydPrev.fields[fk] : null;
        cell += trendArrow(val, valPrev, TREND_FIELDS[fk]);
      }
      html += `<td class="bh-td-val">${cell}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody>';
  table.innerHTML = html;

  document.getElementById('bh-content').classList.remove('hidden');
}

function buildSummaryRows(years, yearData, latestYr, prevYr) {
  let html = '';

  const ydLatest = latestYr != null ? yearData[String(latestYr)] : null;
  const ydPrev   = prevYr   != null ? yearData[String(prevYr)]   : null;

  // Reported / override emissions row
  html += '<tr class="bh-row-summary"><td class="bh-td-field"><strong>GHG Emissions (tCO₂e)</strong></td>';
  for (const yr of years) {
    const yd = yearData[String(yr)];
    const v  = yd ? yd.emissions : null;
    let cell = v != null ? fmtNum(v, 1) : '—';
    if (yr === latestYr) {
      cell += trendArrow(v, ydPrev ? ydPrev.emissions : null, false);
    }
    html += `<td class="bh-td-val bh-td-emissions">${cell}</td>`;
  }
  html += '</tr>';

  // LL97 Fine row
  html += '<tr class="bh-row-summary"><td class="bh-td-field"><strong>LL97 Fine</strong></td>';
  for (const yr of years) {
    const yd      = yearData[String(yr)];
    const fine    = yd ? yd.fine : null;
    const src     = yd ? yd.source : null;
    let fineCell;
    if (!yd) {
      fineCell = '—';
    } else if (src === 'manual') {
      fineCell = fine != null ? (fine > 0 ? `<span class="rp-fine-amount">${fmtDollars(fine)}</span>` : '<span class="rp-fine-zero">$0</span>') : '—';
    } else if (fine == null) {
      fineCell = '<span class="rp-fine-dash">—</span>';
    } else if (fine > 0) {
      fineCell = `<span class="rp-fine-amount">${fmtDollars(fine)}</span>`;
    } else {
      fineCell = '<span class="rp-fine-zero">$0</span>';
    }
    if (yr === latestYr) {
      fineCell += trendArrow(fine, ydPrev ? ydPrev.fine : null, false);
    }
    const fineClass = fine != null && fine > 0 ? ' rp-td-has-fine' : '';
    html += `<td class="bh-td-val${fineClass}">${fineCell}</td>`;
  }
  html += '</tr>';

  // Data source row
  html += '<tr class="bh-row-source"><td class="bh-td-field">Data Source</td>';
  for (const yr of years) {
    const yd  = yearData[String(yr)];
    const src = yd ? yd.source : null;
    const badge = src === 'manual'
      ? '<span class="badge badge-manual">Manual</span>'
      : src === 'll84'
      ? '<span class="badge badge-ll84">LL84</span>'
      : '—';
    html += `<td class="bh-td-val">${badge}</td>`;
  }
  html += '</tr>';

  return html;
}

loadHistory();
