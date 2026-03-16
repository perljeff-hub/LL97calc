/* active_building_nav.js
 * Handles the active-building chip dropdown.
 * Uses event delegation so it works with chips rendered dynamically after DOMContentLoaded.
 */
'use strict';

(function () {
  document.addEventListener('DOMContentLoaded', function () {

    // Event delegation on document — chip may be injected into the DOM after load
    document.addEventListener('click', function (e) {
      const chip = e.target.closest('.active-building-chip');
      if (chip) {
        e.stopPropagation();
        const wrap = chip.closest('.active-building-chip-wrap');
        if (!wrap) return;
        const opening = !wrap.classList.contains('abt-open');
        // Close any other open wraps
        document.querySelectorAll('.active-building-chip-wrap.abt-open').forEach(function (w) {
          if (w !== wrap) w.classList.remove('abt-open');
        });
        wrap.classList.toggle('abt-open');
        if (opening && !wrap.dataset.loaded) {
          wrap.dataset.loaded = 'true';
          loadRecentBuildings(wrap);
        }
        return;
      }
      // Clicks inside the tooltip/dropdown should not close it
      if (e.target.closest('.active-building-tooltip')) return;
      // Click outside — close all
      document.querySelectorAll('.active-building-chip-wrap.abt-open').forEach(function (w) {
        w.classList.remove('abt-open');
      });
    });

  });

  async function loadRecentBuildings(wrap) {
    const tooltip = wrap.querySelector('.active-building-tooltip');
    if (!tooltip) return;

    const section = document.createElement('div');
    section.className = 'abt-dropdown-section';
    section.innerHTML = '<div class="abt-dropdown-loading">Loading recent buildings\u2026</div>';
    tooltip.appendChild(section);

    try {
      const resp = await fetch('/api/saved-buildings');
      if (!resp.ok) throw new Error('Request failed');
      const data = await resp.json();

      let activeName = null;
      try {
        const ak = JSON.parse(localStorage.getItem('ll97_active') || 'null');
        if (ak && ak.saveName) activeName = ak.saveName;
      } catch (_) {}

      const buildings = (data.buildings || []).slice(0, 5);
      section.innerHTML = '';

      if (buildings.length) {
        const label = document.createElement('div');
        label.className = 'abt-dropdown-label';
        label.textContent = 'Recent Buildings';
        section.appendChild(label);

        buildings.forEach(function (b) {
          const item = document.createElement('div');
          item.className = 'abt-dropdown-item' + (b.save_name === activeName ? ' abt-active-item' : '');

          const name = document.createElement('span');
          name.className = 'abt-item-name';
          name.textContent = b.save_name;
          item.appendChild(name);

          const addrStr = [b.address, b.borough].filter(Boolean).join(', ');
          if (addrStr) {
            const addr = document.createElement('span');
            addr.className = 'abt-item-addr';
            addr.textContent = addrStr;
            item.appendChild(addr);
          }

          item.addEventListener('click', function () {
            switchBuilding(b.save_name);
          });
          section.appendChild(item);
        });
      }

      const footer = document.createElement('div');
      footer.className = 'abt-dropdown-footer';
      const link = document.createElement('a');
      link.href = '/portfolio';
      link.textContent = 'Select from Portfolio \u2192';
      footer.appendChild(link);
      section.appendChild(footer);

    } catch (_) {
      section.innerHTML = '<div class="abt-dropdown-loading">Could not load recent buildings.</div>';
    }
  }

  async function switchBuilding(saveName) {
    try {
      const resp = await fetch('/api/saved-buildings/' + encodeURIComponent(saveName));
      if (!resp.ok) throw new Error('Building not found');
      const data = await resp.json();
      const b = data.building;
      const occ = (b.occupancy_groups || []).map(function (g) {
        return { type: g.property_type, area: String(g.floor_area) };
      });
      const buildingData = {
        source: 'saved',
        save_name: b.save_name,
        bbl: b.source_bbl || '',
        bin: b.source_bin || '',
        property_name: b.property_name || '',
        address: b.address || '',
        borough: b.borough || '',
        postcode: b.postcode || '',
        year_ending: b.year_ending || '',
        gross_floor_area: b.gross_floor_area || null,
        energy_star_score: b.energy_star_score || '',
        electricity_kwh: b.electricity_kwh || null,
        natural_gas_therms: b.natural_gas_therms || null,
        district_steam_mlb: b.district_steam_mlb || null,
        fuel_oil_2_gal: b.fuel_oil_2_gal || null,
        fuel_oil_4_gal: b.fuel_oil_4_gal || null,
        occupancy_groups: b.occupancy_groups || [],
      };
      const state = {
        saveName: b.save_name,
        buildingData: buildingData,
        isDirty: false,
        form: {
          elec:  String(b.electricity_kwh    || ''),
          gas:   String(b.natural_gas_therms  || ''),
          steam: String(b.district_steam_mlb  || ''),
          fo2:   String(b.fuel_oil_2_gal      || ''),
          fo4:   String(b.fuel_oil_4_gal      || ''),
        },
        occRows: occ,
      };
      localStorage.setItem('ll97_calc_state', JSON.stringify(state));
      localStorage.setItem('ll97_active', JSON.stringify({ saveName: b.save_name }));
      if (b.selected_scenario_id) {
        localStorage.setItem('ll97_timeline_scenario_id', String(b.selected_scenario_id));
      } else {
        localStorage.removeItem('ll97_timeline_scenario_id');
      }
      // Determine destination: stay on building-specific pages; from building-history
      // go to Historical Performance; otherwise go to Calculate.
      const path = window.location.pathname;
      const buildingPages = ['/calculate', '/manage', '/reduction-plan'];
      let dest;
      if (buildingPages.includes(path)) {
        dest = path;
      } else if (path.startsWith('/building-history/')) {
        dest = '/building-history/' + encodeURIComponent(b.save_name);
      } else {
        dest = '/calculate';
      }
      window.location.href = dest;
    } catch (e) {
      alert('Could not load building: ' + e.message);
    }
  }
})();
