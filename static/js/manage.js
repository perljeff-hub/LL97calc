/**
 * manage.js — LL97 Compliance Timeline + Financial Summary
 */
'use strict';

const SESSION_KEY = 'll97_calc_state';

const PERIOD_YEAR_MAP = [
  { period: '2024_2029', years: [2024,2025,2026,2027,2028,2029] },
  { period: '2030_2034', years: [2030,2031,2032,2033,2034] },
  { period: '2035_2039', years: [2035,2036,2037,2038,2039] },
  { period: '2040_2049', years: [2040,2041,2042,2043,2044,2045,2046,2047,2048,2049] },
  { period: '2050_plus', years: [2050] },
];

// Fuel key order for table columns (matches backend calculate_utility_costs keys)
const FUEL_KEYS = ['electricity', 'natural_gas', 'district_steam', 'fuel_oil_2', 'fuel_oil_4'];

// Fuel key → backend prices_config key mapping
const FUEL_TO_PRICE_KEY = {
  electricity:    'electricity_kwh',
  natural_gas:    'natural_gas_therm',
  district_steam: 'district_steam_mlb',
  fuel_oil_2:     'fuel_oil_2_gal',
  fuel_oil_4:     'fuel_oil_4_gal',
};

// Fuel key → energy input key mapping
const FUEL_TO_ENERGY_KEY = {
  electricity:    'electricity_kwh',
  natural_gas:    'natural_gas_therms',
  district_steam: 'district_steam_mlb',
  fuel_oil_2:     'fuel_oil_2_gal',
  fuel_oil_4:     'fuel_oil_4_gal',
};

let manageChart          = null;
let pricesConfig         = null;  // {fuel_key: {price, escalator}} from /api/settings/prices
let baseEnergyQty        = null;  // raw energy quantities from state
let baseUtilityCostsByYr = [];    // per-year baseline costs (length 27)
let cachedYears          = [];
let cachedBaseFines      = [];
let cachedScenData       = null;
let cachedScenName       = '';
let showFuelDetail       = false;

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

  const payload = buildCalcPayload(state);
  if (!payload.occupancy_groups.length) {
    showError('No occupancy groups found. Please configure building data on the Calculate tab first.');
    return;
  }

  // Fetch prices/escalators and run calculate in parallel
  let calcData, pricesResp;
  try {
    [calcData, pricesResp] = await Promise.all([
      fetch('/api/calculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json()),
      fetch('/api/settings/prices').then(r => r.json()),
    ]);
    if (calcData.error) { showError(calcData.error); return; }
  } catch (e) {
    showError('Could not reach the server. Please try again.');
    return;
  }

  pricesConfig  = pricesResp.prices;  // {electricity_kwh: {price, escalator}, ...}
  baseEnergyQty = {
    electricity_kwh:    parseFloat(state.form?.elec)  || 0,
    natural_gas_therms: parseFloat(state.form?.gas)   || 0,
    district_steam_mlb: parseFloat(state.form?.steam) || 0,
    fuel_oil_2_gal:     parseFloat(state.form?.fo2)   || 0,
    fuel_oil_4_gal:     parseFloat(state.form?.fo4)   || 0,
  };
  // Compute per-year baseline costs using escalating prices
  baseUtilityCostsByYr = computeBaselineCostsByYear();

  buildChart(state.saveName, calcData.results);
  buildFinancialTable();
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

    const bar    = document.getElementById('manage-scenario-bar');
    const select = document.getElementById('manage-scenario-select');
    scenarios.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
    bar.classList.remove('hidden');

    // Check for scenario auto-select passed from Reduction Plan "See Scenario on Timeline"
    const storedScenId = sessionStorage.getItem('ll97_rp_scenario_id');
    let autoSelectId = null;
    if (storedScenId) {
      sessionStorage.removeItem('ll97_rp_scenario_id');
      const targetId = parseInt(storedScenId, 10);
      if ([...select.options].some(o => parseInt(o.value, 10) === targetId)) {
        select.value = String(targetId);
        autoSelectId = targetId;
      }
    }

    select.addEventListener('change', async () => {
      const scenarioId = parseInt(select.value, 10) || null;
      if (!scenarioId) {
        cachedScenData = null;
        cachedScenName = '';
        buildChart(buildingName, results);
        buildFinancialTable();
        return;
      }
      const loadingEl = document.getElementById('manage-scenario-loading');
      loadingEl.classList.remove('hidden');
      try {
        const compPayload = { ...buildCalcPayload(state), scenario_id: scenarioId };
        const compResp = await fetch('/api/scenario-compute', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(compPayload),
        });
        const compData = await compResp.json();
        if (!compResp.ok || compData.error) throw new Error(compData.error);
        cachedScenData = compData.yearly_data;
        cachedScenName = scenarios.find(s => s.id === scenarioId)?.name || '';
        buildChart(buildingName, results, cachedScenData, cachedScenName);
        buildFinancialTable();
      } catch (e) {
        cachedScenData = null; cachedScenName = '';
        buildChart(buildingName, results);
        buildFinancialTable();
      } finally {
        loadingEl.classList.add('hidden');
      }
    });

    // Auto-trigger comparison chart for the pre-selected scenario
    if (autoSelectId) {
      select.dispatchEvent(new Event('change'));
    }
  } catch (e) { /* scenarios optional */ }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

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

/**
 * Compute per-year baseline utility costs for all 27 years (2024-2050),
 * applying the annual price escalator to each fuel.
 */
function computeBaselineCostsByYear() {
  const YEARS = Array.from({length: 27}, (_, i) => 2024 + i);
  return YEARS.map(year => {
    let total = 0;
    const fuels = {};
    FUEL_KEYS.forEach(fk => {
      const priceKey = FUEL_TO_PRICE_KEY[fk];
      const energyKey = FUEL_TO_ENERGY_KEY[fk];
      const cfg = pricesConfig[priceKey] || {price: 0, escalator: 0};
      const escalatedPrice = cfg.price * Math.pow(1 + cfg.escalator / 100, year - 2024);
      const qty = baseEnergyQty[energyKey] || 0;
      const cost = qty * escalatedPrice;
      fuels[fk] = Math.round(cost);
      total += cost;
    });
    fuels.total = Math.round(total);
    return fuels;
  });
}

function getFuelLabel(fk) {
  const map = {
    electricity: 'Electricity', natural_gas: 'Nat. Gas',
    district_steam: 'Steam', fuel_oil_2: 'Oil #2', fuel_oil_4: 'Oil #4',
  };
  return map[fk] || fk;
}

function $d(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
function $f(v) { return v ? '$' + Math.round(v).toLocaleString('en-US') : '—'; }

// ── CHART ─────────────────────────────────────────────────────────────────────

function buildChart(buildingName, results, scenarioData = null, scenarioName = '') {
  if (manageChart) { manageChart.destroy(); manageChart = null; }

  cachedYears = []; cachedBaseFines = [];
  const baseEmissions = [], limits = [];

  for (const { period, years } of PERIOD_YEAR_MAP) {
    const r = results[period];
    if (!r) continue;
    for (const yr of years) {
      cachedYears.push(String(yr));
      baseEmissions.push(Math.round(r.emissions * 100) / 100);
      limits.push(Math.round(r.limit * 100) / 100);
      cachedBaseFines.push(Math.round(r.penalty));
    }
  }

  let hasFine, cumulativeFines, datasets;

  if (scenarioData && scenarioData.length) {
    const scenFines     = scenarioData.map(d => Math.round(d.fine));
    const scenEmissions = scenarioData.map(d => Math.round(d.emissions * 100) / 100);
    hasFine = scenFines.map(f => f > 0);
    let cum = 0;
    cumulativeFines = scenFines.map(f => (cum += f));

    datasets = [
      // Baseline fine bars — grey, LEFT (order 4 < scenario order 5)
      {
        type: 'bar', label: 'Baseline Fine', data: cachedBaseFines,
        backgroundColor: 'rgba(150,150,150,0.45)', borderColor: 'rgba(110,110,110,0.6)',
        borderWidth: 1, yAxisID: 'y2', order: 4,
      },
      // Scenario fine bars — orange, RIGHT
      {
        type: 'bar', label: `${scenarioName} Fine`, data: scenFines,
        backgroundColor: 'rgba(211,84,0,0.65)', borderColor: '#d35400',
        borderWidth: 1, yAxisID: 'y2', order: 5,
      },
      // Baseline GHG — grey dashed (behind scenario line)
      {
        type: 'line', label: 'Baseline GHG Emissions', data: baseEmissions,
        borderColor: 'rgba(130,130,130,0.7)', backgroundColor: 'transparent',
        borderDash: [4,4], yAxisID: 'y', tension: 0, pointRadius: 0,
        borderWidth: 2, fill: false, order: 3,
      },
      // Scenario GHG — red solid, on top
      {
        type: 'line', label: `${scenarioName} GHG Emissions`, data: scenEmissions,
        borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.07)',
        yAxisID: 'y', tension: 0, pointRadius: 3, pointHoverRadius: 5,
        borderWidth: 2.5, fill: false, order: 1,
      },
      // Limit — green
      {
        type: 'line', label: 'Emissions Limit', data: limits,
        borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,0.07)',
        yAxisID: 'y', tension: 0, pointRadius: 3, pointHoverRadius: 5,
        borderWidth: 2.5, fill: false, order: 2,
      },
      // Scenario cumulative fine
      {
        type: 'line', label: `${scenarioName} Cumulative Fine`, data: cumulativeFines,
        borderColor: '#8e44ad', backgroundColor: 'transparent', borderDash: [6,3],
        yAxisID: 'y2', tension: 0, pointRadius: 2, pointHoverRadius: 4,
        borderWidth: 2, fill: false, order: 6,
      },
    ];
  } else {
    hasFine = cachedBaseFines.map(f => f > 0);
    let cum = 0;
    cumulativeFines = cachedBaseFines.map(f => (cum += f));

    datasets = [
      {
        type: 'bar', label: 'Annual Fine', data: cachedBaseFines,
        backgroundColor: 'rgba(211,84,0,0.65)', borderColor: '#d35400',
        borderWidth: 1, yAxisID: 'y2', order: 4,
      },
      {
        type: 'line', label: 'Baseline GHG Emissions', data: baseEmissions,
        borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.07)',
        yAxisID: 'y', tension: 0, pointRadius: 3, pointHoverRadius: 5,
        borderWidth: 2.5, fill: false, order: 1,
      },
      {
        type: 'line', label: 'Emissions Limit', data: limits,
        borderColor: '#27ae60', backgroundColor: 'rgba(39,174,96,0.07)',
        yAxisID: 'y', tension: 0, pointRadius: 3, pointHoverRadius: 5,
        borderWidth: 2.5, fill: false, order: 2,
      },
      {
        type: 'line', label: 'Cumulative Fine', data: cumulativeFines,
        borderColor: '#8e44ad', backgroundColor: 'transparent', borderDash: [6,3],
        yAxisID: 'y2', tension: 0, pointRadius: 2, pointHoverRadius: 4,
        borderWidth: 2, fill: false, order: 3,
      },
    ];
  }

  document.getElementById('manage-building-name').textContent = buildingName;
  document.getElementById('manage-loading').classList.add('hidden');
  document.getElementById('manage-chart-container').classList.remove('hidden');

  const ctx = document.getElementById('manage-chart').getContext('2d');
  manageChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: cachedYears, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, padding: 18, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return ctx.dataset.yAxisID === 'y2'
                ? `  ${ctx.dataset.label}: $${v.toLocaleString('en-US')}`
                : `  ${ctx.dataset.label}: ${v.toLocaleString('en-US')} tCO₂e`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Year', font: { size: 12, weight: 'bold' }, color: '#495057' },
          ticks: {
            color: ctx => hasFine[ctx.index] ? '#c0392b' : '#495057',
            font:  ctx => ({ size: 11, weight: hasFine[ctx.index] ? 'bold' : 'normal' }),
          },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          position: 'left',
          title: { display: true, text: 'GHG Emissions (tCO₂e)', font: { size: 12, weight: 'bold' }, color: '#c0392b' },
          beginAtZero: true,
          ticks: { callback: v => v.toLocaleString('en-US') },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y2: {
          position: 'right',
          title: { display: true, text: 'Fine Amount ($)', font: { size: 12, weight: 'bold' }, color: '#d35400' },
          beginAtZero: true,
          ticks: { callback: v => '$' + v.toLocaleString('en-US') },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

// ── FINANCIAL TABLE ───────────────────────────────────────────────────────────

function buildFinancialTable() {
  const container = document.getElementById('manage-fin-container');
  if (!container || !baseUtilityCostsByYr.length || !cachedYears.length) return;
  container.innerHTML = '';
  container.classList.remove('hidden');

  const hasScen = Array.isArray(cachedScenData) && cachedScenData.length > 0;

  // ── Section wrapper
  const section = document.createElement('section');
  section.className = 'card wide-card';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'fin-hdr';
  hdr.innerHTML = `
    <div>
      <h2 class="card-title">Financial Summary — Year by Year</h2>
      <p class="card-desc" style="margin-bottom:.5rem">
        Annual energy costs at default prices
        (electricity&nbsp;$0.15/kWh · nat.&nbsp;gas&nbsp;$1.50/therm · steam&nbsp;$18/mLb ·
        oil&nbsp;#2&nbsp;$3.00/gal · oil&nbsp;#4&nbsp;$2.90/gal),
        LL97 fines${hasScen ? ', and one-time measure capital costs' : ''}.
      </p>
    </div>
    <button id="fin-fuel-toggle" class="btn btn-ghost btn-sm" style="white-space:nowrap;align-self:flex-start">
      ${showFuelDetail ? '&#8722; Hide Fuel Detail' : '&#43; Show Fuel Detail'}
    </button>`;
  section.appendChild(hdr);

  const wrap = document.createElement('div');
  wrap.className = 'fin-table-wrap';
  wrap.appendChild(buildFinTable(hasScen));
  section.appendChild(wrap);
  container.appendChild(section);

  document.getElementById('fin-fuel-toggle').addEventListener('click', () => {
    showFuelDetail = !showFuelDetail;
    buildFinancialTable();
  });
}

function buildFinTable(hasScen) {
  const table = document.createElement('table');
  table.className = 'fin-table';

  // ── THEAD ─────────────────────────────────────────────────────────────────
  const thead = document.createElement('thead');
  // Row 1 — group labels
  const gr = document.createElement('tr');
  gr.className = 'fin-group-row';

  const yearGrTh = document.createElement('th');
  yearGrTh.rowSpan = 2;
  yearGrTh.textContent = 'Year';
  gr.appendChild(yearGrTh);

  const baseCols = showFuelDetail ? 8 : 3;   // 5 fuels + total + fine + sum  OR  total + fine + sum
  const scenCols = showFuelDetail ? 10 : 4;  // + measure cost + sum

  const baseTh = document.createElement('th');
  baseTh.colSpan = baseCols;
  baseTh.className = 'fin-group-th fin-base-th';
  baseTh.textContent = 'Baseline';
  gr.appendChild(baseTh);

  if (hasScen) {
    const scenTh = document.createElement('th');
    scenTh.colSpan = scenCols;
    scenTh.className = 'fin-group-th fin-scen-th';
    scenTh.textContent = cachedScenName;
    gr.appendChild(scenTh);
  }
  thead.appendChild(gr);

  // Row 2 — column labels
  const cr = document.createElement('tr');
  function colTh(html, cls) {
    const th = document.createElement('th');
    th.innerHTML = html;
    if (cls) th.className = cls;
    cr.appendChild(th);
  }
  if (showFuelDetail) {
    FUEL_KEYS.forEach(k => colTh(getFuelLabel(k), 'fin-fuel-col fin-base-col'));
    colTh('Total Energy', 'fin-base-col fin-tot-col');
  } else {
    colTh('Energy Cost', 'fin-base-col fin-tot-col');
  }
  colTh('Fine', 'fin-base-col fin-fine-col');
  colTh('Sum', 'fin-base-col fin-sum-col');

  if (hasScen) {
    if (showFuelDetail) {
      FUEL_KEYS.forEach(k => colTh(getFuelLabel(k), 'fin-fuel-col fin-scen-col'));
      colTh('Total Energy', 'fin-scen-col fin-tot-col');
    } else {
      colTh('Energy Cost', 'fin-scen-col fin-tot-col');
    }
    colTh('Fine', 'fin-scen-col fin-fine-col');
    colTh('Measure Cost', 'fin-scen-col fin-measure-col');
    colTh('Sum', 'fin-scen-col fin-sum-col');
  }
  thead.appendChild(cr);
  table.appendChild(thead);

  // ── TBODY ─────────────────────────────────────────────────────────────────
  const tbody = document.createElement('tbody');
  const tot = {
    baseEnergy: 0, baseFine: 0, baseSum: 0,
    scenEnergy: 0, scenFine: 0, measureCost: 0, scenSum: 0,
    baseFuels: Object.fromEntries(FUEL_KEYS.map(k => [k, 0])),
    scenFuels:  Object.fromEntries(FUEL_KEYS.map(k => [k, 0])),
  };

  cachedYears.forEach((yr, i) => {
    const bFine     = cachedBaseFines[i] || 0;
    const bYrCosts  = baseUtilityCostsByYr[i] || {};
    const bTotal    = bYrCosts.total || 0;
    const sd        = hasScen ? cachedScenData[i] : null;

    const tr = document.createElement('tr');
    function td(html, cls, isNeg) {
      const cell = document.createElement('td');
      cell.innerHTML = html;
      cell.className = (cls || '') + (isNeg ? ' fin-neg' : '');
      tr.appendChild(cell);
    }

    td(yr, 'fin-year-td');

    // Baseline energy (escalated per-year costs)
    if (showFuelDetail) {
      FUEL_KEYS.forEach(k => {
        const v = bYrCosts[k] || 0;
        tot.baseFuels[k] += v;
        td($f(v), 'fin-base-col fin-fuel-col');
      });
      tot.baseEnergy += bTotal;
      td('<strong>' + $d(bTotal) + '</strong>', 'fin-base-col fin-tot-col');
    } else {
      tot.baseEnergy += bTotal;
      td($d(bTotal), 'fin-base-col fin-tot-col');
    }
    // Baseline fine + sum
    tot.baseFine += bFine;
    td($f(bFine), 'fin-base-col fin-fine-col' + (bFine > 0 ? ' fin-fine-nz' : ''));
    const bSum = bTotal + bFine;
    tot.baseSum += bSum;
    td('<strong>' + $d(bSum) + '</strong>', 'fin-base-col fin-sum-col');

    if (sd) {
      const sTotal = sd.energy_cost?.total || 0;
      const sFine  = sd.fine || 0;
      const mCost  = sd.measure_cost || 0;

      if (showFuelDetail) {
        FUEL_KEYS.forEach(k => {
          const v = sd.energy_cost?.[k] || 0;
          tot.scenFuels[k] += v;
          td($f(v), 'fin-scen-col fin-fuel-col');
        });
        tot.scenEnergy += sTotal;
        td('<strong>' + $d(sTotal) + '</strong>', 'fin-scen-col fin-tot-col');
      } else {
        tot.scenEnergy += sTotal;
        td($d(sTotal), 'fin-scen-col fin-tot-col');
      }
      tot.scenFine += sFine;
      td($f(sFine), 'fin-scen-col fin-fine-col' + (sFine > 0 ? ' fin-fine-nz' : ''));
      tot.measureCost += mCost;
      td($f(mCost), 'fin-scen-col fin-measure-col' + (mCost > 0 ? ' fin-measure-nz' : ''));
      const sSum = sTotal + sFine + mCost;
      tot.scenSum += sSum;
      td('<strong>' + $d(sSum) + '</strong>', 'fin-scen-col fin-sum-col');
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  // ── TFOOT ─────────────────────────────────────────────────────────────────
  const tfoot = document.createElement('tfoot');
  const ttr   = document.createElement('tr');
  ttr.className = 'fin-totals-row';
  function ttd(html, cls) {
    const cell = document.createElement('td');
    cell.innerHTML = html;
    if (cls) cell.className = cls;
    ttr.appendChild(cell);
  }
  ttd('<strong>27-Year Total</strong>', 'fin-year-td');
  if (showFuelDetail) {
    FUEL_KEYS.forEach(k => ttd('<strong>' + $d(tot.baseFuels[k]) + '</strong>', 'fin-base-col fin-fuel-col'));
    ttd('<strong>' + $d(tot.baseEnergy) + '</strong>', 'fin-base-col fin-tot-col');
  } else {
    ttd('<strong>' + $d(tot.baseEnergy) + '</strong>', 'fin-base-col fin-tot-col');
  }
  ttd('<strong>' + $d(tot.baseFine) + '</strong>', 'fin-base-col fin-fine-col');
  ttd('<strong>' + $d(tot.baseSum) + '</strong>', 'fin-base-col fin-sum-col');
  if (hasScen) {
    if (showFuelDetail) {
      FUEL_KEYS.forEach(k => ttd('<strong>' + $d(tot.scenFuels[k]) + '</strong>', 'fin-scen-col fin-fuel-col'));
      ttd('<strong>' + $d(tot.scenEnergy) + '</strong>', 'fin-scen-col fin-tot-col');
    } else {
      ttd('<strong>' + $d(tot.scenEnergy) + '</strong>', 'fin-scen-col fin-tot-col');
    }
    ttd('<strong>' + $d(tot.scenFine) + '</strong>', 'fin-scen-col fin-fine-col');
    ttd('<strong>' + $d(tot.measureCost) + '</strong>', 'fin-scen-col fin-measure-col');
    ttd('<strong>' + $d(tot.scenSum) + '</strong>', 'fin-scen-col fin-sum-col');
  }
  tfoot.appendChild(ttr);
  table.appendChild(tfoot);

  return table;
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────

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
