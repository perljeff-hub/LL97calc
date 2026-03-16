/* Real Performance Over Time — Frontend Logic */
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
      await fetch('/api/real-performance/refresh-links', { method: 'POST' });
    }
    const resp = await fetch('/api/real-performance');
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

    for (const yr of _years) {
      const cell = bldg.year_data[yr];
      html += renderCell(bldg.save_name, yr, cell);
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

function renderCell(saveName, year, cell) {
  if (!cell) {
    // No data — show add link
    return `<td class="rp-td-empty"><span class="rp-add-link" data-rp-add data-save-n="${esc(saveName)}" data-yr="${esc(year)}">+ Add</span></td>`;
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
    <div class="rp-cell-emissions">${emissions}</div>
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
    const resp = await fetch('/api/real-performance/manual-entry', {
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

// ── INIT ─────────────────────────────────────────────────────────────────────
loadData(false);
