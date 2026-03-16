/* Historical Performance Over Time — Frontend Logic */
'use strict';

// ── HELPERS ──────────────────────────────────────────────────────────────────
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

// ── STATE ─────────────────────────────────────────────────────────────────────
let _years = [];
let _buildings = [];
let _pendingEntry = null;  // {save_name, year}

// ── MAIN LOAD ────────────────────────────────────────────────────────────────
async function loadData(forceRefresh) {
  document.getElementById('rp-loading').classList.remove('hidden');
  document.getElementById('rp-content').classList.add('hidden');
  document.getElementById('rp-empty').classList.add('hidden');
  document.getElementById('rp-error').classList.add('hidden');

  try {
    if (forceRefresh) {
      await fetch('/api/historical-performance/refresh-links', { method: 'POST' });
    }
    const resp = await fetch('/api/historical-performance');
    if (!resp.ok) throw new Error('Failed to load');
    const data = await resp.json();

    _years = data.years || [];
    _buildings = data.buildings || [];

    document.getElementById('rp-loading').classList.add('hidden');

    if (!_buildings.length) {
      document.getElementById('rp-empty').classList.remove('hidden');
      return;
    }
    renderTable();
    document.getElementById('rp-content').classList.remove('hidden');
  } catch (e) {
    document.getElementById('rp-loading').classList.add('hidden');
    const errEl = document.getElementById('rp-error');
    errEl.textContent = 'Failed to load performance data. Please try again.';
    errEl.classList.remove('hidden');
  }
}

// ── TABLE RENDER ─────────────────────────────────────────────────────────────
function renderTable() {
  const table = document.getElementById('rp-table');

  // Header row
  let html = '<thead><tr>';
  html += '<th class="rp-th-building">Building</th>';
  for (const yr of _years) {
    html += `<th class="rp-th-year">${esc(yr)}</th>`;
  }
  html += '</tr></thead><tbody>';

  // Data rows
  for (const bldg of _buildings) {
    const nameHtml = `<a href="/building-history/${encodeURIComponent(bldg.save_name)}" class="rp-bldg-link">${esc(bldg.display_name || bldg.save_name)}</a>`;
    const subHtml  = bldg.address ? `<div class="rp-bldg-sub">${esc(bldg.address)}${bldg.borough ? ', ' + esc(bldg.borough) : ''}</div>` : '';

    html += `<tr><td class="rp-td-building">${nameHtml}${subHtml}</td>`;

    // Compute trend for most recent year with emissions data
    const yearsWithEmissions = _years.filter(yr => bldg.year_data[yr] && bldg.year_data[yr].emissions != null);
    const mostRecentYr = yearsWithEmissions.length > 0 ? yearsWithEmissions[yearsWithEmissions.length - 1] : null;
    const prevYr       = yearsWithEmissions.length > 1 ? yearsWithEmissions[yearsWithEmissions.length - 2] : null;
    const emissionsTrend = (mostRecentYr && prevYr)
      ? bldg.year_data[mostRecentYr].emissions - bldg.year_data[prevYr].emissions
      : null;

    for (const yr of _years) {
      const cell = bldg.year_data[yr];
      const trend = yr === mostRecentYr ? emissionsTrend : null;
      html += renderCell(bldg.save_name, yr, cell, trend);
    }
    html += '</tr>';
  }

  html += '</tbody>';
  table.innerHTML = html;

  // Attach click handlers for "+ Add" and manual cell edit links
  table.querySelectorAll('[data-rp-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { saveN, yr } = btn.dataset;
      openManualModal(saveN, yr, null);
    });
  });
  table.querySelectorAll('[data-rp-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { saveN, yr, emissions, fine } = btn.dataset;
      openManualModal(saveN, yr, { emissions: parseFloat(emissions), fine: parseFloat(fine) });
    });
  });
}

function renderCell(saveName, year, cell, trend) {
  if (!cell) {
    // No data — show add link
    return `<td class="rp-td-empty"><span class="rp-add-link" data-rp-add data-save-n="${esc(saveName)}" data-yr="${esc(year)}">+ Add</span></td>`;
  }

  // Trend indicator: red ▲ if emissions rose, green ▼ if they fell
  let trendHtml = '';
  if (trend != null && trend !== 0) {
    const up   = trend > 0;
    const cls  = up ? 'rp-trend-bad' : 'rp-trend-good';
    const sym  = up ? '▲' : '▼';
    const diff = fmtNum(Math.abs(trend), 0);
    trendHtml  = ` <span class="rp-trend ${cls}" title="${up ? '+' : '−'}${diff} tCO₂e vs prior year">${sym}</span>`;
  }

  const emissions = cell.emissions != null ? fmtNum(cell.emissions, 0) + ' tCO₂e' : '—';
  const fineVal   = cell.fine;
  let fineHtml;
  if (fineVal == null) {
    fineHtml = '<span class="rp-fine-dash">—</span>';
  } else if (fineVal > 0) {
    fineHtml = `<span class="rp-fine-amount">${fmtDollars(fineVal)}</span>`;
  } else {
    fineHtml = '<span class="rp-fine-zero">$0</span>';
  }

  const srcClass = cell.source === 'manual' ? ' rp-td-manual' : ' rp-td-ll84';
  const hasFine  = fineVal != null && fineVal > 0 ? ' rp-td-has-fine' : '';

  // Edit control for manual entries
  const editHtml = cell.source === 'manual'
    ? `<span class="rp-edit-link" data-rp-edit data-save-n="${esc(saveName)}" data-yr="${esc(year)}" data-emissions="${cell.emissions != null ? cell.emissions : ''}" data-fine="${fineVal != null ? fineVal : ''}">edit</span>`
    : '';

  return `<td class="rp-td-data${srcClass}${hasFine}">
    <div class="rp-cell-emissions">${emissions}${trendHtml}</div>
    <div class="rp-cell-fine">${fineHtml}</div>
    ${editHtml}
  </td>`;
}

// ── MANUAL ENTRY MODAL ───────────────────────────────────────────────────────
function openManualModal(saveName, year, existing) {
  _pendingEntry = { save_name: saveName, year: parseInt(year) };

  const bldg = _buildings.find(b => b.save_name === saveName);
  const desc = `<strong>${esc(bldg ? (bldg.display_name || bldg.save_name) : saveName)}</strong> — ${esc(year)}`;
  document.getElementById('rp-modal-desc').innerHTML = desc;
  document.getElementById('rp-modal-title').textContent = existing ? 'Edit Data' : 'Enter Data';
  document.getElementById('rp-modal-emissions').value = existing ? (existing.emissions || '') : '';
  document.getElementById('rp-modal-fine').value      = existing ? (existing.fine != null ? existing.fine : '') : '';
  document.getElementById('rp-modal-error').classList.add('hidden');
  document.getElementById('rp-modal-backdrop').classList.remove('hidden');
  setTimeout(() => document.getElementById('rp-modal-emissions').focus(), 50);
}

function closeManualModal() {
  document.getElementById('rp-modal-backdrop').classList.add('hidden');
  _pendingEntry = null;
}

async function saveManualEntry() {
  if (!_pendingEntry) return;

  const emissions = parseFloat(document.getElementById('rp-modal-emissions').value);
  const fine      = parseFloat(document.getElementById('rp-modal-fine').value);
  const errEl     = document.getElementById('rp-modal-error');

  if (isNaN(emissions) || emissions < 0) {
    errEl.textContent = 'Please enter a valid emissions value (≥ 0).';
    errEl.classList.remove('hidden');
    return;
  }
  if (isNaN(fine) || fine < 0) {
    errEl.textContent = 'Please enter a valid fine amount (≥ 0).';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const resp = await fetch('/api/historical-performance/manual-entry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        building_save_name: _pendingEntry.save_name,
        calendar_year:      _pendingEntry.year,
        emissions,
        fine,
      }),
    });
    if (!resp.ok) throw new Error('Save failed');
    closeManualModal();
    await loadData(false);
  } catch (e) {
    errEl.textContent = 'Save failed. Please try again.';
    errEl.classList.remove('hidden');
  }
}

// ── EVENT LISTENERS ──────────────────────────────────────────────────────────
document.getElementById('rp-refresh-btn').addEventListener('click', () => loadData(true));
document.getElementById('rp-modal-close').addEventListener('click', closeManualModal);
document.getElementById('rp-modal-cancel-btn').addEventListener('click', closeManualModal);
document.getElementById('rp-modal-save-btn').addEventListener('click', saveManualEntry);
document.getElementById('rp-modal-backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeManualModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeManualModal(); });

// ── ACTIVE BUILDING CHIP ─────────────────────────────────────────────────────
// Render the active-building chip from localStorage so the Historical
// Performance page doesn't appear to "forget" the active building.
function renderActiveBuildingChip() {
  const nav = document.getElementById('active-building-nav');
  if (!nav) return;
  try {
    const state = JSON.parse(localStorage.getItem('ll97_calc_state') || 'null');
    if (!state || !state.saveName) return;
    const r = state.buildingData || {};
    const svgBuilding =
      `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0">` +
      `<rect x="3" y="4" width="10" height="11" rx=".5" stroke="currentColor" stroke-width="1.5"/>` +
      `<rect x="5" y="6" width="2" height="2" rx=".3" fill="currentColor"/>` +
      `<rect x="9" y="6" width="2" height="2" rx=".3" fill="currentColor"/>` +
      `<rect x="5" y="10" width="2" height="2" rx=".3" fill="currentColor"/>` +
      `<rect x="9" y="10" width="2" height="2" rx=".3" fill="currentColor"/>` +
      `<path d="M6.5 15V12h3v3" stroke="currentColor" stroke-width="1.3" fill="none"/>` +
      `<path d="M1 4l7-3 7 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>` +
      `</svg>`;
    let tipHtml = `<div class="abt-name">${esc(r.property_name || state.saveName)}</div>`;
    if (r.address) tipHtml += `<div class="abt-row">${esc(r.address)}${r.borough ? ', ' + esc(r.borough) : ''}</div>`;
    if (r.gross_floor_area) tipHtml += `<div class="abt-row"><strong>${Number(r.gross_floor_area).toLocaleString('en-US')}</strong> sq ft</div>`;
    nav.innerHTML =
      `<div class="active-building-chip-wrap">` +
      `<span class="active-building-chip">${svgBuilding}<span class="active-building-chip-name">${esc(state.saveName)}</span></span>` +
      `<div class="active-building-tooltip">${tipHtml}</div>` +
      `</div>`;
    const calcLink = document.getElementById('calc-nav-link');
    const dd = document.getElementById('manage-nav-dropdown');
    const bt = document.getElementById('manage-nav-btn');
    if (calcLink) { calcLink.classList.remove('nav-link-disabled'); calcLink.removeAttribute('title'); }
    if (dd)       { dd.classList.remove('disabled'); }
    if (bt)       { bt.classList.remove('nav-link-disabled'); }
  } catch (e) { /* ignore */ }
}

// ── INIT ─────────────────────────────────────────────────────────────────────
renderActiveBuildingChip();
loadData(false);
