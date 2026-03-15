/* active_building_nav.js
 * Enhances the active-building chip in the header with a click-to-open
 * dropdown showing the 5 most recent buildings and a Portfolio link.
 */
'use strict';

(function () {
  document.addEventListener('DOMContentLoaded', function () {
    const wrap = document.querySelector('.active-building-chip-wrap');
    if (!wrap) return;

    const chip = wrap.querySelector('.active-building-chip');
    if (!chip) return;

    let loaded = false;

    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      const opening = !wrap.classList.contains('abt-open');
      wrap.classList.toggle('abt-open');
      if (opening && !loaded) {
        loaded = true;
        loadRecentBuildings(wrap);
      }
    });

    // Close on outside click
    document.addEventListener('click', function () {
      wrap.classList.remove('abt-open');
    });

    // Prevent clicks inside the tooltip/dropdown from closing it
    const tooltip = wrap.querySelector('.active-building-tooltip');
    if (tooltip) {
      tooltip.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    }
  });

  async function loadRecentBuildings(wrap) {
    const tooltip = wrap.querySelector('.active-building-tooltip');
    if (!tooltip) return;

    // Append a section for the recent-buildings dropdown
    const section = document.createElement('div');
    section.className = 'abt-dropdown-section';
    section.innerHTML = '<div class="abt-dropdown-loading">Loading recent buildings…</div>';
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
      link.textContent = 'Select from Portfolio →';
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
      // Stay on the current page if it's a building-specific view, otherwise go to Calculate
      const path = window.location.pathname;
      const buildingPages = ['/calculate', '/manage', '/reduction-plan'];
      window.location.href = buildingPages.includes(path) ? path : '/calculate';
    } catch (e) {
      alert('Could not load building: ' + e.message);
    }
  }
})();
