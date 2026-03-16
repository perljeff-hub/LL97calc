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

// ── Page-level data (set by renderPage, used by modals) ─────────────────────
let _pageData = null;

async function loadHistory() {
  try {
    const resp = await fetch(`/api/building-history/${encodeURIComponent(saveName)}`);
    if (!resp.ok) throw new Error('Not found');
    const data = await resp.json();
    _pageData = data;
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

  // Header
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

  // The most recent year with data (for trend arrows and no-remove-button)
  const dataYears  = years.filter(yr => yearData[String(yr)] != null);
  const latestYr   = dataYears.length > 0 ? dataYears[dataYears.length - 1] : null;
  const prevYr     = dataYears.length > 1 ? dataYears[dataYears.length - 2] : null;

  const table = document.getElementById('bh-table');
  let html = '<thead><tr><th class="bh-th-field">Field</th>';
  for (const yr of years) {
    html += `<th class="bh-th-year">${esc(String(yr))}</th>`;
  }
  html += '</tr></thead><tbody>';

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
      if (yd == null) {
        html += `<td class="bh-td-val bh-td-missing"></td>`;
      } else {
        html += `<td class="bh-td-val">${cell}</td>`;
      }
    }
    html += '</tr>';
  }

  // Action row: "Search for missing data" / "Remove from this building"
  html += `<tr class="bh-action-row"><td class="bh-td-field bh-action-label"></td>`;
  for (const yr of years) {
    const yd = yearData[String(yr)];
    if (yd == null) {
      // Missing year — show "Search for missing data" link
      html += `<td class="bh-td-val bh-td-missing">` +
        `<button class="btn-link bh-search-link" data-year="${yr}">Search for missing data</button>` +
        `</td>`;
    } else if (yd.has_ph_record && yr !== latestYr) {
      // Has a performance_history record and is not the most-recent year — allow removal
      html += `<td class="bh-td-val">` +
        `<button class="btn-link bh-remove-link" data-year="${yr}">Remove from this building</button>` +
        `</td>`;
    } else {
      html += `<td class="bh-td-val"></td>`;
    }
  }
  html += '</tr>';

  html += '</tbody>';
  table.innerHTML = html;

  // Wire up search links
  table.querySelectorAll('.bh-search-link').forEach(btn => {
    btn.addEventListener('click', () => openSearchModal(parseInt(btn.dataset.year, 10)));
  });
  // Wire up remove links
  table.querySelectorAll('.bh-remove-link').forEach(btn => {
    btn.addEventListener('click', () => openRemoveModal(parseInt(btn.dataset.year, 10)));
  });

  document.getElementById('bh-content').classList.remove('hidden');
}

function buildSummaryRows(years, yearData, latestYr, prevYr) {
  let html = '';

  const ydLatest = latestYr != null ? yearData[String(latestYr)] : null;
  const ydPrev   = prevYr   != null ? yearData[String(prevYr)]   : null;

  // GHG Emissions row
  html += '<tr class="bh-row-summary"><td class="bh-td-field"><strong>GHG Emissions (tCO₂e)</strong></td>';
  for (const yr of years) {
    const yd = yearData[String(yr)];
    if (yd == null) {
      html += `<td class="bh-td-val bh-td-missing"></td>`;
      continue;
    }
    const v  = yd.emissions;
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
    const yd   = yearData[String(yr)];
    if (yd == null) {
      html += `<td class="bh-td-val bh-td-missing"></td>`;
      continue;
    }
    const fine = yd.fine;
    const src  = yd.source;
    let fineCell;
    if (src === 'manual') {
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
    if (yd == null) {
      html += `<td class="bh-td-val bh-td-missing"></td>`;
      continue;
    }
    const src = yd.source;
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

// ── Search modal ─────────────────────────────────────────────────────────────
let _searchTargetYear = null;
let _searchTimeout    = null;

function openSearchModal(year) {
  _searchTargetYear = year;
  document.getElementById('bh-search-modal-desc').textContent =
    `Search LL84 database to find data for ${year} for this building.`;
  document.getElementById('bh-search-input').value = '';
  document.getElementById('bh-search-results').classList.add('hidden');
  document.getElementById('bh-search-results').innerHTML = '';
  document.getElementById('bh-search-modal').classList.remove('hidden');
  document.getElementById('bh-search-input').focus();
}

function closeSearchModal() {
  document.getElementById('bh-search-modal').classList.add('hidden');
  _searchTargetYear = null;
}

async function performBhSearch(q) {
  const resultsEl = document.getElementById('bh-search-results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="search-result-item" style="color:#868e96">Searching…</div>';
  try {
    const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&ll84_only=true`);
    const data = await resp.json();
    if (!data.results || data.results.length === 0) {
      resultsEl.innerHTML = '<div class="search-result-item" style="color:#868e96">No buildings found.</div>';
      return;
    }
    resultsEl.innerHTML = '';
    data.results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const floor = r.gross_floor_area ? `${fmtNum(r.gross_floor_area)} sf` : '';
      const es    = r.energy_star_score ? `ES Score: ${r.energy_star_score}` : '';
      item.innerHTML =
        `<div class="sri-main">${esc(r.property_name || r.address || 'Unknown')}</div>` +
        `<div class="sri-sub">${esc(r.address || '')} ${esc(r.borough || '')} ${esc(r.postcode || '')}` +
        `${r.bbl ? ` &bull; BBL: ${esc(r.bbl)}` : ''}${r.bin ? ` &bull; BIN: ${esc(r.bin)}` : ''}</div>` +
        `<div class="sri-meta">${floor}${floor && es ? ' &bull; ' : ''}${es}` +
        `${r.year_ending ? ` &bull; Data year: ${r.year_ending.substring(0, 4)}` : ''}</div>`;
      item.addEventListener('click', () => selectSearchResult(r));
      resultsEl.appendChild(item);
    });
  } catch (e) {
    resultsEl.innerHTML = '<div class="search-result-item" style="color:#c0392b">Search failed. Please try again.</div>';
  }
}

async function selectSearchResult(r) {
  if (_searchTargetYear == null) return;
  try {
    const resp = await fetch(`/api/building-history/${encodeURIComponent(saveName)}/link-year`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calendar_year:    _searchTargetYear,
        ll84_bbl:         r.bbl         || '',
        ll84_bin:         r.bin         || '',
        ll84_year_ending: r.year_ending || '',
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert('Could not link data: ' + (err.error || resp.statusText));
      return;
    }
    closeSearchModal();
    // Reload the page data
    const histResp = await fetch(`/api/building-history/${encodeURIComponent(saveName)}`);
    if (!histResp.ok) throw new Error('Reload failed');
    _pageData = await histResp.json();
    renderPage(_pageData);
  } catch (e) {
    alert('An error occurred. Please try again.');
  }
}

// Wire up search modal events
document.getElementById('bh-search-modal-close').addEventListener('click', closeSearchModal);
document.getElementById('bh-search-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('bh-search-modal')) closeSearchModal();
});
document.getElementById('bh-search-input').addEventListener('input', function () {
  clearTimeout(_searchTimeout);
  const q = this.value.trim();
  if (q.length < 3) {
    document.getElementById('bh-search-results').classList.add('hidden');
    return;
  }
  _searchTimeout = setTimeout(() => performBhSearch(q), 350);
});
document.getElementById('bh-search-btn').addEventListener('click', () => {
  const q = document.getElementById('bh-search-input').value.trim();
  if (q.length >= 3) performBhSearch(q);
});

// ── Remove year modal ────────────────────────────────────────────────────────
let _removeTargetYear = null;

function openRemoveModal(year) {
  _removeTargetYear = year;
  document.getElementById('bh-remove-modal-desc').textContent =
    `Are you sure you want to remove the ${year} data from this building?`;
  document.getElementById('bh-remove-modal').classList.remove('hidden');
}

function closeRemoveModal() {
  document.getElementById('bh-remove-modal').classList.add('hidden');
  _removeTargetYear = null;
}

async function confirmRemove() {
  if (_removeTargetYear == null) return;
  const year = _removeTargetYear;
  closeRemoveModal();
  try {
    const resp = await fetch(
      `/api/building-history/${encodeURIComponent(saveName)}/year/${year}`,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      alert('Could not remove year data. Please try again.');
      return;
    }
    // Reload
    const histResp = await fetch(`/api/building-history/${encodeURIComponent(saveName)}`);
    if (!histResp.ok) throw new Error('Reload failed');
    _pageData = await histResp.json();
    renderPage(_pageData);
  } catch (e) {
    alert('An error occurred. Please try again.');
  }
}

document.getElementById('bh-remove-modal-close').addEventListener('click', closeRemoveModal);
document.getElementById('bh-remove-cancel-btn').addEventListener('click', closeRemoveModal);
document.getElementById('bh-remove-confirm-btn').addEventListener('click', confirmRemove);
document.getElementById('bh-remove-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('bh-remove-modal')) closeRemoveModal();
});

loadHistory();
