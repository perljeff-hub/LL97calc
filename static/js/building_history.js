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
  property_name:      'Property Name',
  address:            'Address',
  borough:            'Borough',
  postcode:           'Zip Code',
  gross_floor_area:   'Gross Floor Area (sq ft)',
  energy_star_score:  'Energy Star Score',
  electricity_kwh:    'Electricity (kWh)',
  natural_gas_therms: 'Natural Gas (therms)',
  district_steam_mlb: 'District Steam (Mlb)',
  fuel_oil_2_gal:     '#2 Fuel Oil (gal)',
  fuel_oil_4_gal:     '#4 Fuel Oil (gal)',
  reported_ghg:       'Reported GHG (tCO₂e)',
};

function formatFieldValue(key, val) {
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

function renderPage(data) {
  document.getElementById('bh-loading').classList.add('hidden');

  const bldg     = data.building || {};
  const years    = data.years    || [];
  const yearData = data.year_data || {};
  const changedRows = new Set(data.changed_rows || []);

  document.getElementById('bh-title').textContent = bldg.property_name || bldg.save_name || saveName;
  const addrParts = [bldg.address, bldg.borough, bldg.postcode].filter(Boolean);
  document.getElementById('bh-address').textContent = addrParts.join(', ');

  const table = document.getElementById('bh-table');
  let html = '<thead><tr><th class="bh-th-field">Field</th>';
  for (const yr of years) {
    html += `<th class="bh-th-year">${esc(String(yr))}</th>`;
  }
  html += '</tr></thead><tbody>';

  // Summary rows (emissions + fine) at top
  html += buildSummaryRows(years, yearData);

  // Separator
  html += `<tr class="bh-separator-row"><td colspan="${years.length + 1}" class="bh-separator">LL84 Reported Data</td></tr>`;

  // Field rows
  for (const fk of data.field_keys || []) {
    const label    = FIELD_LABELS[fk] || fk;
    const changed  = changedRows.has(fk);
    const rowClass = changed ? ' bh-row-changed' : '';

    html += `<tr class="${rowClass}"><td class="bh-td-field">${esc(label)}</td>`;
    for (const yr of years) {
      const yd = yearData[String(yr)];
      const val = yd && yd.fields ? yd.fields[fk] : null;
      html += `<td class="bh-td-val">${formatFieldValue(fk, val)}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody>';
  table.innerHTML = html;

  document.getElementById('bh-content').classList.remove('hidden');
}

function buildSummaryRows(years, yearData) {
  let html = '';

  // Reported / override emissions row
  html += '<tr class="bh-row-summary"><td class="bh-td-field"><strong>GHG Emissions (tCO₂e)</strong></td>';
  for (const yr of years) {
    const yd = yearData[String(yr)];
    const v  = yd ? yd.emissions : null;
    html += `<td class="bh-td-val bh-td-emissions">${v != null ? fmtNum(v, 1) : '—'}</td>`;
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
