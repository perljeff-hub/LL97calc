/**
 * manage.js — LL97 Compliance Timeline (Manage tab)
 *
 * Reads the active building's form inputs from sessionStorage, calls
 * /api/calculate, expands the 5-period results into discrete yearly
 * data (2024–2050), and renders a Chart.js mixed bar+line chart.
 */

'use strict';

const SESSION_KEY = 'll97_calc_state';

// Map each compliance period to the individual calendar years it covers
const PERIOD_YEAR_MAP = [
  { period: '2024_2029', years: [2024,2025,2026,2027,2028,2029] },
  { period: '2030_2034', years: [2030,2031,2032,2033,2034] },
  { period: '2035_2039', years: [2035,2036,2037,2038,2039] },
  { period: '2040_2049', years: [2040,2041,2042,2043,2044,2045,2046,2047,2048,2049] },
  { period: '2050_plus', years: [2050] },
];

// ── INIT ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async function init() {
  let state;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) { showNoBuilding(); return; }
    state = JSON.parse(raw);
    if (!state.saveName) { showNoBuilding(); return; }
  } catch (e) {
    showNoBuilding();
    return;
  }

  // Build the /api/calculate payload from saved form state
  const payload = {
    electricity_kwh:    parseFloat(state.form?.elec)  || 0,
    natural_gas_therms: parseFloat(state.form?.gas)   || 0,
    district_steam_mlb: parseFloat(state.form?.steam) || 0,
    fuel_oil_2_gal:     parseFloat(state.form?.fo2)   || 0,
    fuel_oil_4_gal:     parseFloat(state.form?.fo4)   || 0,
    occupancy_groups: (state.occRows || [])
      .map(r => ({ property_type: r.type, floor_area: parseFloat(r.area) || 0 }))
      .filter(g => g.property_type && g.floor_area > 0),
  };

  if (!payload.occupancy_groups.length) {
    showError('No occupancy groups found. Please configure building data on the Calculate tab first.');
    return;
  }

  try {
    const resp = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      showError(data.error || 'Calculation failed. Please try again.');
      return;
    }
    buildChart(state.saveName, data.results);
  } catch (e) {
    showError('Could not reach the server. Please try again.');
  }
});

// ── CHART ─────────────────────────────────────────────────────────────────────

function buildChart(buildingName, results) {
  const years        = [];
  const emissionsKg  = [];  // tCO2e → kgCO2e (*1000), absolute building total
  const limitsKg     = [];
  const annualFines  = [];  // dollars
  const hasFine      = [];

  // Expand 5 periods into 27 individual years
  for (const { period, years: pyears } of PERIOD_YEAR_MAP) {
    const r = results[period];
    if (!r) continue;
    for (const yr of pyears) {
      years.push(String(yr));
      emissionsKg.push(Math.round(r.emissions * 1000));
      limitsKg.push(Math.round(r.limit * 1000));
      annualFines.push(Math.round(r.penalty));
      hasFine.push(r.penalty > 0);
    }
  }

  // Cumulative fine: running sum across years
  const cumulativeFines = [];
  let cumSum = 0;
  for (const f of annualFines) {
    cumSum += f;
    cumulativeFines.push(cumSum);
  }

  // Show building name and reveal chart card
  document.getElementById('manage-building-name').textContent = buildingName;
  document.getElementById('manage-loading').classList.add('hidden');
  document.getElementById('manage-chart-container').classList.remove('hidden');

  const ctx = document.getElementById('manage-chart').getContext('2d');

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: years,
      datasets: [
        // Annual Fine bars — rendered first (behind lines)
        {
          type:            'bar',
          label:           'Annual Fine',
          data:            annualFines,
          backgroundColor: 'rgba(211, 84, 0, 0.65)',
          borderColor:     '#d35400',
          borderWidth:     1,
          yAxisID:         'y2',
          order:           4,
        },
        // Baseline GHG Emissions line
        {
          type:            'line',
          label:           'Baseline GHG Emissions',
          data:            emissionsKg,
          borderColor:     '#c0392b',
          backgroundColor: 'rgba(192, 57, 43, 0.07)',
          yAxisID:         'y',
          tension:         0,
          pointRadius:     3,
          pointHoverRadius: 5,
          borderWidth:     2.5,
          fill:            false,
          order:           1,
        },
        // Emissions Limit line
        {
          type:            'line',
          label:           'Emissions Limit',
          data:            limitsKg,
          borderColor:     '#27ae60',
          backgroundColor: 'rgba(39, 174, 96, 0.07)',
          yAxisID:         'y',
          tension:         0,
          pointRadius:     3,
          pointHoverRadius: 5,
          borderWidth:     2.5,
          fill:            false,
          order:           2,
        },
        // Cumulative Fine line
        {
          type:            'line',
          label:           'Cumulative Fine',
          data:            cumulativeFines,
          borderColor:     '#8e44ad',
          backgroundColor: 'transparent',
          borderDash:      [6, 3],
          yAxisID:         'y2',
          tension:         0,
          pointRadius:     2,
          pointHoverRadius: 4,
          borderWidth:     2,
          fill:            false,
          order:           3,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: {
        mode:      'index',
        intersect: false,
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            padding:       20,
            font:          { size: 12 },
          },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (ctx.dataset.yAxisID === 'y2') {
                return `  ${ctx.dataset.label}: $${v.toLocaleString('en-US')}`;
              }
              return `  ${ctx.dataset.label}: ${v.toLocaleString('en-US')} kgCO₂e`;
            },
          },
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text:    'Year',
            font:    { size: 12, weight: 'bold' },
            color:   '#495057',
          },
          ticks: {
            // Bold red for years with a fine
            color: ctx => hasFine[ctx.index] ? '#c0392b' : '#495057',
            font:  ctx => ({
              size:   11,
              weight: hasFine[ctx.index] ? 'bold' : 'normal',
            }),
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          position: 'left',
          title: {
            display: true,
            text:    'GHG Emissions (kgCO₂e)',
            font:    { size: 12, weight: 'bold' },
            color:   '#c0392b',
          },
          beginAtZero: true,
          ticks: {
            callback: v => v.toLocaleString('en-US'),
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y2: {
          position: 'right',
          title: {
            display: true,
            text:    'Fine Amount ($)',
            font:    { size: 12, weight: 'bold' },
            color:   '#d35400',
          },
          beginAtZero: true,
          ticks: {
            callback: v => '$' + v.toLocaleString('en-US'),
          },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function showNoBuilding() {
  document.getElementById('manage-loading').classList.add('hidden');
  document.getElementById('manage-no-building').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('manage-loading').classList.add('hidden');
  const el = document.getElementById('manage-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
