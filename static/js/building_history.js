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


  if (val == null) return '—';
  if (key === 'gross_floor_area' || key === 'electricity_kwh') return fmtNum(val, 0);
  if (key === 'natural_gas_therms' || key === 'fuel_oil_2_gal' || key === 'fuel_oil_4_gal') return fmtNum(val, 1);
  if (key === 'district_steam_mlb') return fmtNum(val, 3);
  if (key === 'reported_ghg') return fmtNum(val, 1);
  return esc(String(val));
}

// Extract save_name from URL path: /building-history/<save_name>
const saveName = decodeURIComponent(window.location.pathname.replace('/building-history/', ''));

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
  const occ = (bldg.occupancy_groups || []).map(g => ({ type: g.property_type, area: String(g.floor_area) }));
  const buildingData = {
    source: 'saved',
    save_name: bldg.save_name,
    bbl: bldg.source_bbl || '',
    bin: bldg.source_bin || '',
    property_name: bldg.property_name || '',
    address: bldg.address || '',
    borough: bldg.borough || '',
    postcode: bldg.postcode || '',
    year_ending: bldg.year_ending || '',
    gross_floor_area: bldg.gross_floor_area || null,
    energy_star_score: bldg.energy_star_score || '',
    electricity_kwh: bldg.electricity_kwh || null,
    natural_gas_therms: bldg.natural_gas_therms || null,
    district_steam_mlb: bldg.district_steam_mlb || null,
    fuel_oil_2_gal: bldg.fuel_oil_2_gal || null,
    fuel_oil_4_gal: bldg.fuel_oil_4_gal || null,
    occupancy_groups: bldg.occupancy_groups || [],
  };
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

  // Render the active-building chip in the header
  const nav = document.getElementById('active-building-nav');
  if (nav && bldg.save_name) {
    const svgB = `<svg class="active-building-chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
    const addrStr = [bldg.address, bldg.borough].filter(Boolean).join(', ');
    const tipHtml = addrStr ? `<div class="active-building-tip-name">${esc(bldg.save_name)}</div><div class="active-building-tip-addr">${esc(addrStr)}</div>` : `<div class="active-building-tip-name">${esc(bldg.save_name)}</div>`;
    nav.innerHTML =
      `<div class="active-building-chip-wrap">` +
      `<span class="active-building-chip">${svgB}<span class="active-building-chip-name">${esc(bldg.save_name)}</span></span>` +
      `<div class="active-building-tooltip">${tipHtml}</div>` +
      `</div>`;
  }
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
