/**
 * manage.js — LL97 Compliance Timeline (Manage tab)
 *
 * Reads the active building's form inputs from sessionStorage, calls
 * /api/calculate, expands the 5-period results into discrete yearly
 * data (2024–2050), and renders a Chart.js mixed bar+line chart.
 *
 * Also loads available Reduction Plan scenarios and, when one is
 * selected, overlays scenario bars + a scenario emissions line.
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

let manageChart = null;   // current Chart.js instance

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
  const payload = buildCalcPayload(state);
  if (!payload.occupancy_groups.length) {
    showError('No occupancy groups found. Please configure building data on the Calculate tab first.');
    return;
  }

  let calcData;
  try {
    const resp = await fetch('/api/calculate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    calcData = await resp.json();
    if (!resp.ok || calcData.error) {
      showError(calcData.error || 'Calculation failed. Please try again.');
      return;
    }
  } catch (e) {
    showError('Could not reach the server. Please try again.');
    return;
  }

  // Show baseline chart
  buildChart(state.saveName, calcData.results);

  // Attempt to load scenarios (non-blocking)
  loadScenarios(state.saveName, calcData.results, state);
});

// ── SCENARIO LOADER ───────────────────────────────────────────────────────────

async function loadScenarios(buildingName, results, state) {
  try {
    const resp = await fetch(`/api/scenarios?building=${encodeURIComponent(buildingName)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const scenarios = data.scenarios || [];
    if (!scenarios.length) return;

    // Populate scenario dropdown
    const bar    = document.getElementById('manage-scenario-bar');
    const select = document.getElementById('manage-scenario-select');
    scenarios.forEach(s => {
      const opt       = document.createElement('option');
      opt.value       = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
    bar.classList.remove('hidden');

    select.addEventListener('change', async () => {
      const scenarioId = parseInt(select.value, 10) || null;
      if (!scenarioId) {
        buildChart(buildingName, results);
        return;
      }

      const loadingEl = document.getElementById('manage-scenario-loading');
      loadingEl.classList.remove('hidden');

      try {
        const compPayload = {
          ...buildCalcPayload(state),
          scenario_id: scenarioId,
        };
        const compResp = await fetch('/api/scenario-compute', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(compPayload),
        });
        const compData = await compResp.json();
        if (!compResp.ok || compData.error) throw new Error(compData.error || 'Compute failed');

        const scenarioName = scenarios.find(s => s.id === scenarioId)?.name || '';
        buildChart(buildingName, results, compData.yearly_data, scenarioName);
      } catch (e) {
        // Revert to baseline if compute fails
        buildChart(buildingName, results);
        console.error('Scenario compute failed:', e);
      } finally {
        loadingEl.classList.add('hidden');
      }
    });
  } catch (e) {
    // Scenarios are optional; silently ignore errors
  }
}

// ── PAYLOAD HELPER ────────────────────────────────────────────────────────────

function buildCalcPayload(state) {
  return {
    electricity_kwh:    parseFloat(state.form?.elec)  || 0,
    natural_gas_therms: parseFloat(state.form?.gas)   || 0,
    district_steam_mlb: parseFloat(state.form?.steam) || 0,
    fuel_oil_2_gal:     parseFloat(state.form?.fo2)   || 0,
    fuel_oil_4_gal:     parseFloat(state.form?.fo4)   || 0,
    occupancy_groups: (state.occRows || [])
      .map(r => ({ property_type: r.type, floor_area: parseFloat(r.area) || 0 }))
      .filter(g => g.property_type && g.floor_area > 0),
  };
}

// ── CHART ─────────────────────────────────────────────────────────────────────

/**
 * @param {string}  buildingName  — shown in chart title
 * @param {object}  results       — period-keyed baseline results from /api/calculate
 * @param {Array}   [scenarioData] — per-year scenario data from /api/scenario-compute
 * @param {string}  [scenarioName]
 */
function buildChart(buildingName, results, scenarioData = null, scenarioName = '') {
  // Destroy previous chart instance if any
  if (manageChart) { manageChart.destroy(); manageChart = null; }

  const years          = [];
  const baseEmissions  = [];
  const limits         = [];
  const baseFines      = [];
  const baseHasFine    = [];

  // Expand 5 periods → 27 individual years (baseline)
  for (const { period, years: pyears } of PERIOD_YEAR_MAP) {
    const r = results[period];
    if (!r) continue;
    for (const yr of pyears) {
      years.push(String(yr));
      baseEmissions.push(Math.round(r.emissions * 100) / 100);
      limits.push(Math.round(r.limit * 100) / 100);
      baseFines.push(Math.round(r.penalty));
      baseHasFine.push(r.penalty > 0);
    }
  }

  // Determine what to use for x-axis colouring + cumulative line
  let hasFine, cumulativeFines, datasets;

  if (scenarioData && scenarioData.length) {
    // ── Scenario overlay mode ───────────────────────────────────────────────
    const scenFines     = scenarioData.map(d => Math.round(d.fine));
    const scenEmissions = scenarioData.map(d => Math.round(d.emissions * 100) / 100);
    hasFine             = scenFines.map(f => f > 0);

    cumulativeFines = [];
    let cum = 0;
    for (const f of scenFines) { cum += f; cumulativeFines.push(cum); }

    // Cumulative for baseline (for reference in tooltip)
    let baseCum = 0;
    const baseCumFines = baseFines.map(f => { baseCum += f; return baseCum; });

    datasets = [
      // Baseline fine bars — grey, behind everything
      {
        type:            'bar',
        label:           'Baseline Fine',
        data:            baseFines,
        backgroundColor: 'rgba(150,150,150,0.45)',
        borderColor:     'rgba(120,120,120,0.6)',
        borderWidth:     1,
        yAxisID:         'y2',
        order:           6,
      },
      // Scenario fine bars — orange
      {
        type:            'bar',
        label:           `${scenarioName} Fine`,
        data:            scenFines,
        backgroundColor: 'rgba(211,84,0,0.65)',
        borderColor:     '#d35400',
        borderWidth:     1,
        yAxisID:         'y2',
        order:           5,
      },
      // Baseline GHG — grey dashed, behind scenario line
      {
        type:            'line',
        label:           'Baseline GHG Emissions',
        data:            baseEmissions,
        borderColor:     'rgba(130,130,130,0.7)',
        backgroundColor: 'transparent',
        borderDash:      [4, 4],
        yAxisID:         'y',
        tension:         0,
        pointRadius:     0,
        borderWidth:     2,
        fill:            false,
        order:           3,
      },
      // Scenario GHG — red solid, on top
      {
        type:            'line',
        label:           `${scenarioName} GHG Emissions`,
        data:            scenEmissions,
        borderColor:     '#c0392b',
        backgroundColor: 'rgba(192,57,43,0.07)',
        yAxisID:         'y',
        tension:         0,
        pointRadius:     3,
        pointHoverRadius: 5,
        borderWidth:     2.5,
        fill:            false,
        order:           1,
      },
      // Emissions limit — green, always
      {
        type:            'line',
        label:           'Emissions Limit',
        data:            limits,
        borderColor:     '#27ae60',
        backgroundColor: 'rgba(39,174,96,0.07)',
        yAxisID:         'y',
        tension:         0,
        pointRadius:     3,
        pointHoverRadius: 5,
        borderWidth:     2.5,
        fill:            false,
        order:           2,
      },
      // Scenario cumulative fine — purple dashed
      {
        type:            'line',
        label:           `${scenarioName} Cumulative Fine`,
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
        order:           4,
      },
    ];
  } else {
    // ── Baseline-only mode (original behaviour) ─────────────────────────────
    hasFine = baseHasFine;

    cumulativeFines = [];
    let cum = 0;
    for (const f of baseFines) { cum += f; cumulativeFines.push(cum); }

    datasets = [
      {
        type:            'bar',
        label:           'Annual Fine',
        data:            baseFines,
        backgroundColor: 'rgba(211,84,0,0.65)',
        borderColor:     '#d35400',
        borderWidth:     1,
        yAxisID:         'y2',
        order:           4,
      },
      {
        type:            'line',
        label:           'Baseline GHG Emissions',
        data:            baseEmissions,
        borderColor:     '#c0392b',
        backgroundColor: 'rgba(192,57,43,0.07)',
        yAxisID:         'y',
        tension:         0,
        pointRadius:     3,
        pointHoverRadius: 5,
        borderWidth:     2.5,
        fill:            false,
        order:           1,
      },
      {
        type:            'line',
        label:           'Emissions Limit',
        data:            limits,
        borderColor:     '#27ae60',
        backgroundColor: 'rgba(39,174,96,0.07)',
        yAxisID:         'y',
        tension:         0,
        pointRadius:     3,
        pointHoverRadius: 5,
        borderWidth:     2.5,
        fill:            false,
        order:           2,
      },
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
    ];
  }

  // Show building name and reveal chart card
  document.getElementById('manage-building-name').textContent = buildingName;
  document.getElementById('manage-loading').classList.add('hidden');
  document.getElementById('manage-chart-container').classList.remove('hidden');

  const ctx = document.getElementById('manage-chart').getContext('2d');

  manageChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: years, datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, padding: 18, font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (ctx.dataset.yAxisID === 'y2')
                return `  ${ctx.dataset.label}: $${v.toLocaleString('en-US')}`;
              return `  ${ctx.dataset.label}: ${v.toLocaleString('en-US')} tCO₂e`;
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
            color: ctx => hasFine[ctx.index] ? '#c0392b' : '#495057',
            font:  ctx => ({ size: 11, weight: hasFine[ctx.index] ? 'bold' : 'normal' }),
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          position: 'left',
          title: {
            display: true,
            text:    'GHG Emissions (tCO₂e)',
            font:    { size: 12, weight: 'bold' },
            color:   '#c0392b',
          },
          beginAtZero: true,
          ticks: { callback: v => v.toLocaleString('en-US') },
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
          ticks: { callback: v => '$' + v.toLocaleString('en-US') },
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
