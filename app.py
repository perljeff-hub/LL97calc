"""
NYC LL97 Carbon Emissions Calculator
Flask web application
"""

import os
import json
import sqlite3
from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS

# Import LL97 data
import sys
sys.path.insert(0, os.path.dirname(__file__))
from data.emission_factors import (
    DEFAULT_UTILITY_FACTORS, ESPM_LIMITS, ESPM_PROPERTY_TYPES,
    OCCUPANCY_GROUP_LIMITS, UNIT_CONVERSIONS, PENALTY_RATE,
    COMPLIANCE_PERIODS, PERIOD_LABELS, MODIFIABLE_PERIODS, MODIFIABLE_FUELS
)
from data.db_setup import get_db_connection, import_ll84_data, DB_PATH

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'll97-calc-secret-key-change-in-prod')
CORS(app)

# ---------------------------------------------------------------------------
# ESPM property type name normalizer
# LL84 uses the same ESPM names as LL97, but spacing/capitalisation can vary.
# Build a lowercase lookup once at startup.
# ---------------------------------------------------------------------------
_ESPM_LOWER = {t.lower(): t for t in ESPM_PROPERTY_TYPES}

# Explicit alias table for known LL84 variations that don't exactly match
_ESPM_ALIASES = {
    'multi-family housing':           'Multifamily Housing',
    'multi family housing':           'Multifamily Housing',
    'k12 school':                     'K-12 School',
    'k-12 school':                    'K-12 School',
    'parking garage':                 'Parking',
    'parking lot':                    'Parking',
    'non-refrigerated warehouse':     'Non-Refrigerated Warehouse',
    'non refrigerated warehouse':     'Non-Refrigerated Warehouse',
    'refrigerated warehouse':         'Refrigerated Warehouse',
    'fitness center':                 'Fitness Center/Health Club/Gym',
    'health club':                    'Fitness Center/Health Club/Gym',
    'gym':                            'Fitness Center/Health Club/Gym',
    'urgent care':                    'Urgent Care/Clinic/Other Outpatient',
    'clinic':                         'Urgent Care/Clinic/Other Outpatient',
    'post office':                    'Mailing Center/Post Office',
    'mailing center':                 'Mailing Center/Post Office',
    'supermarket':                    'Supermarket/Grocery Store',
    'grocery store':                  'Supermarket/Grocery Store',
    'worship':                        'Worship Facility',
    'house of worship':               'Worship Facility',
    'self storage':                   'Self-Storage Facility',
    'self-storage':                   'Self-Storage Facility',
    'data center':                    'Data Center',
    'social hall':                    'Social/Meeting Hall',
    'meeting hall':                   'Social/Meeting Hall',
    'performing arts':                'Performing Arts',
    'theater':                        'Movie Theater',
    'movie theater':                  'Movie Theater',
    'senior care':                    'Senior Care Community',
    'assisted living':                'Senior Care Community',
    'residential care':               'Residential Care Facility',
    'dormitory':                      'Residence Hall/Dormitory',
    'residence hall':                 'Residence Hall/Dormitory',
    'medical office':                 'Medical Office',
    'financial office':               'Financial Office',
    'bank':                           'Bank Branch',
    'bank branch':                    'Bank Branch',
    'convenience store':              'Convenience Store without Gas Station',
    'laboratory':                     'Laboratory',
    'library':                        'Library',
    'museum':                         'Museum',
    'courthouse':                     'Courthouse',
    'pre-school':                     'Pre-school/Daycare',
    'daycare':                        'Pre-school/Daycare',
    'vocational school':              'Vocational School',
    'college':                        'College/University',
    'university':                     'College/University',
    'adult education':                'Adult Education',
    'ambulatory surgical':            'Ambulatory Surgical Center',
    'automobile dealership':          'Automobile Dealership',
    'car dealership':                 'Automobile Dealership',
    'bowling alley':                  'Bowling Alley',
    'distribution center':            'Distribution Center',
    'warehouse':                      'Non-Refrigerated Warehouse',
    'enclosed mall':                  'Enclosed Mall',
    'lifestyle center':               'Lifestyle Center',
    'strip mall':                     'Strip Mall',
    'wholesale club':                 'Wholesale Club/Supercenter',
    'supercenter':                    'Wholesale Club/Supercenter',
    'transportation terminal':        'Transportation Terminal/Station',
    'transit station':                'Transportation Terminal/Station',
    'manufacturing':                  'Manufacturing/Industrial Plant',
    'industrial':                     'Manufacturing/Industrial Plant',
    'food sales':                     'Food Sales',
    'food service':                   'Food Service',
    'restaurant':                     'Restaurant',
    'hospital':                       'Hospital (General Medical & Surgical)',
}

def normalize_espm_type(raw):
    """Map a raw LL84 ESPM property type string to the canonical LL97 name."""
    if not raw:
        return ''
    # Exact match (case-insensitive, strip whitespace)
    key = raw.strip().lower()
    if key in _ESPM_LOWER:
        return _ESPM_LOWER[key]
    # Check alias table
    if key in _ESPM_ALIASES:
        return _ESPM_ALIASES[key]
    # No match — return as-is so the user can see what came from LL84
    return raw.strip()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_utility_factors(session_settings=None):
    """Return utility factors, merging any user overrides from session."""
    import copy
    factors = copy.deepcopy(DEFAULT_UTILITY_FACTORS)
    if session_settings:
        for period in MODIFIABLE_PERIODS:
            if period in session_settings:
                for fuel, val in session_settings[period].items():
                    try:
                        factors[period][fuel] = float(val)
                    except (ValueError, TypeError):
                        pass
    return factors


def calculate_emissions(energy, utility_factors):
    """
    Calculate annual GHG emissions (tCO2e) for each compliance period.
    energy dict keys:
        electricity_kwh, natural_gas_therms, district_steam_mlb,
        fuel_oil_2_gal, fuel_oil_4_gal
    Returns dict of period -> tCO2e
    """
    uc = UNIT_CONVERSIONS
    # Convert to kBtu for combustion fuels
    ng_kbtu = (energy.get('natural_gas_therms') or 0) * uc['natural_gas_therm_to_kbtu']
    steam_kbtu = (energy.get('district_steam_mlb') or 0) * uc['district_steam_mlb_to_kbtu']
    fo2_kbtu = (energy.get('fuel_oil_2_gal') or 0) * uc['fuel_oil_2_gal_to_kbtu']
    fo4_kbtu = (energy.get('fuel_oil_4_gal') or 0) * uc['fuel_oil_4_gal_to_kbtu']
    elec_kwh = energy.get('electricity_kwh') or 0

    results = {}
    for period in COMPLIANCE_PERIODS:
        f = utility_factors[period]
        emissions = (
            elec_kwh    * f['electricity_kwh'] +
            ng_kbtu     * f['natural_gas_kbtu'] +
            steam_kbtu  * f['district_steam_kbtu'] +
            fo2_kbtu    * f['fuel_oil_2_kbtu'] +
            fo4_kbtu    * f['fuel_oil_4_kbtu']
        )
        # Breakdown by source
        results[period] = {
            'total': round(emissions, 4),
            'breakdown': {
                'electricity':    round(elec_kwh   * f['electricity_kwh'],   4),
                'natural_gas':    round(ng_kbtu    * f['natural_gas_kbtu'],   4),
                'district_steam': round(steam_kbtu * f['district_steam_kbtu'],4),
                'fuel_oil_2':     round(fo2_kbtu   * f['fuel_oil_2_kbtu'],   4),
                'fuel_oil_4':     round(fo4_kbtu   * f['fuel_oil_4_kbtu'],   4),
            }
        }
    return results


def calculate_limit(occupancy_groups, period):
    """
    Calculate building emissions limit for a given period.
    occupancy_groups: list of {'property_type': str, 'floor_area': float}
    Returns tCO2e limit for the period.
    """
    total_limit = 0.0
    for og in occupancy_groups:
        pt = og.get('property_type', '')
        area = float(og.get('floor_area') or 0)
        if pt in ESPM_LIMITS and area > 0:
            factor = ESPM_LIMITS[pt].get(period, 0)
            total_limit += factor * area
    return round(total_limit, 4)


def calculate_penalty(emissions, limit):
    """Calculate annual penalty in dollars."""
    overage = emissions - limit
    if overage <= 0:
        return 0.0
    return round(overage * PENALTY_RATE, 2)


def calculate_utility_costs(energy, prices):
    """
    Calculate annual utility costs.
    prices dict: electricity_kwh, natural_gas_therm, district_steam_mlb,
                 fuel_oil_2_gal, fuel_oil_4_gal
    """
    costs = {
        'electricity':    (energy.get('electricity_kwh') or 0)      * (prices.get('electricity_kwh') or 0),
        'natural_gas':    (energy.get('natural_gas_therms') or 0)   * (prices.get('natural_gas_therm') or 0),
        'district_steam': (energy.get('district_steam_mlb') or 0)   * (prices.get('district_steam_mlb') or 0),
        'fuel_oil_2':     (energy.get('fuel_oil_2_gal') or 0)       * (prices.get('fuel_oil_2_gal') or 0),
        'fuel_oil_4':     (energy.get('fuel_oil_4_gal') or 0)       * (prices.get('fuel_oil_4_gal') or 0),
    }
    costs['total'] = sum(costs.values())
    return {k: round(v, 2) for k, v in costs.items()}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template('index.html',
        espm_property_types=ESPM_PROPERTY_TYPES,
        period_labels=PERIOD_LABELS,
        compliance_periods=COMPLIANCE_PERIODS,
    )


@app.route('/settings')
def settings():
    user_factors = session.get('utility_factors', {})
    return render_template('settings.html',
        default_factors=DEFAULT_UTILITY_FACTORS,
        user_factors=user_factors,
        modifiable_periods=MODIFIABLE_PERIODS,
        modifiable_fuels=MODIFIABLE_FUELS,
        period_labels=PERIOD_LABELS,
    )


@app.route('/api/settings', methods=['POST'])
def save_settings():
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    session['utility_factors'] = data
    return jsonify({'status': 'saved'})


@app.route('/api/settings/reset', methods=['POST'])
def reset_settings():
    session.pop('utility_factors', None)
    return jsonify({'status': 'reset'})


@app.route('/api/settings/current')
def get_settings():
    user_factors = session.get('utility_factors', {})
    factors = get_utility_factors(user_factors)
    return jsonify({
        'current': factors,
        'defaults': DEFAULT_UTILITY_FACTORS,
        'user_overrides': user_factors,
    })


@app.route('/api/search')
def search_buildings():
    """Search LL84 database by address, BBL, or property name."""
    q = request.args.get('q', '').strip()
    if len(q) < 3:
        return jsonify({'results': []})

    if not os.path.exists(DB_PATH):
        return jsonify({'results': [], 'warning': 'LL84 database not yet initialized. Run db_setup.py.'})

    conn = get_db_connection()
    q_like = f'%{q}%'
    rows = conn.execute('''
        SELECT bbl, property_name, address, borough, postcode,
               year_ending, gross_floor_area,
               primary_property_type, primary_floor_area,
               second_property_type,  second_floor_area,
               third_property_type,   third_floor_area,
               electricity_kwh, natural_gas_kbtu, district_steam_kbtu,
               fuel_oil_2_kbtu, fuel_oil_4_kbtu,
               reported_ghg_emissions, energy_star_score
        FROM buildings
        WHERE bbl = ?
           OR UPPER(address) LIKE UPPER(?)
           OR UPPER(property_name) LIKE UPPER(?)
        ORDER BY year_ending DESC, property_name
        LIMIT 20
    ''', (q, q_like, q_like)).fetchall()
    conn.close()

    results = []
    for row in rows:
        r = dict(row)

        # Convert stored kBtu values to natural units for the calculator form
        def kbtu_to(val, divisor):
            return round(val / divisor, 1) if val else None

        ng_therms  = kbtu_to(r['natural_gas_kbtu'],   100)      # kBtu → therms
        steam_mlb  = kbtu_to(r['district_steam_kbtu'], 1194)     # kBtu → Mlb
        fo2_gal    = kbtu_to(r['fuel_oil_2_kbtu'],     138.5)    # kBtu → gallons
        fo4_gal    = kbtu_to(r['fuel_oil_4_kbtu'],     146.0)    # kBtu → gallons
        # electricity_kwh is already stored as kWh (converted on import)
        elec_kwh   = round(r['electricity_kwh'], 0) if r['electricity_kwh'] else None

        # Build occupancy groups list (up to 3 uses from LL84).
        # Include ESPM property types even when per-use floor areas are NULL —
        # this happens when the DB was imported before the *_floor_area columns
        # were added, or when the LL84 API doesn't provide them.
        total_gfa = r['gross_floor_area'] or 0
        occupancy_groups = []
        for type_col, area_col in [
            ('primary_property_type', 'primary_floor_area'),
            ('second_property_type',  'second_floor_area'),
            ('third_property_type',   'third_floor_area'),
        ]:
            raw_type  = r.get(type_col) or ''
            area      = r.get(area_col)
            norm_type = normalize_espm_type(raw_type)
            if not norm_type:
                continue                          # no type → skip slot entirely
            floor_area = round(float(area), 0) if (area is not None and float(area) > 0) else None
            occupancy_groups.append({
                'property_type': norm_type,
                'floor_area':    floor_area,
            })

        # Floor-area fallbacks when individual areas are missing
        if occupancy_groups:
            # If exactly one group and its area is unknown, use total GFA
            if len(occupancy_groups) == 1 and not occupancy_groups[0]['floor_area'] and total_gfa:
                occupancy_groups[0]['floor_area'] = round(total_gfa, 0)
        else:
            # No property types at all — give a blank row so the UI shows something
            if total_gfa:
                occupancy_groups.append({'property_type': '', 'floor_area': round(total_gfa, 0)})

        results.append({
            'bbl':              r['bbl'],
            'property_name':    r['property_name'],
            'address':          r['address'],
            'borough':          r['borough'],
            'postcode':         r['postcode'],
            'year_ending':      r['year_ending'],
            'gross_floor_area': total_gfa,
            'electricity_kwh':  elec_kwh,
            'natural_gas_therms': ng_therms,
            'district_steam_mlb': steam_mlb,
            'fuel_oil_2_gal':   fo2_gal,
            'fuel_oil_4_gal':   fo4_gal,
            'occupancy_groups': occupancy_groups,
            'reported_ghg':     r['reported_ghg_emissions'],
            'energy_star_score': r['energy_star_score'],
        })

    return jsonify({'results': results})


@app.route('/api/calculate', methods=['POST'])
def calculate():
    """Main calculation endpoint."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    # Energy inputs
    energy = {
        'electricity_kwh':      _safe_float(data.get('electricity_kwh')),
        'natural_gas_therms':   _safe_float(data.get('natural_gas_therms')),
        'district_steam_mlb':   _safe_float(data.get('district_steam_mlb')),
        'fuel_oil_2_gal':       _safe_float(data.get('fuel_oil_2_gal')),
        'fuel_oil_4_gal':       _safe_float(data.get('fuel_oil_4_gal')),
    }

    # Occupancy groups (up to 4)
    occupancy_groups = []
    for og in (data.get('occupancy_groups') or []):
        pt = og.get('property_type', '').strip()
        area = _safe_float(og.get('floor_area'))
        if pt and area and area > 0:
            occupancy_groups.append({'property_type': pt, 'floor_area': area})

    if not occupancy_groups:
        return jsonify({'error': 'At least one occupancy group with floor area is required'}), 400

    total_floor_area = sum(og['floor_area'] for og in occupancy_groups)

    # Energy prices for cost analysis
    prices = {
        'electricity_kwh':     _safe_float(data.get('price_electricity')) or 0.15,
        'natural_gas_therm':   _safe_float(data.get('price_natural_gas')) or 1.50,
        'district_steam_mlb':  _safe_float(data.get('price_district_steam')) or 18.00,
        'fuel_oil_2_gal':      _safe_float(data.get('price_fuel_oil_2')) or 3.00,
        'fuel_oil_4_gal':      _safe_float(data.get('price_fuel_oil_4')) or 2.90,
    }

    # Get utility factors (with user overrides from session)
    user_overrides = session.get('utility_factors', {})
    utility_factors = get_utility_factors(user_overrides)

    # Calculate emissions
    emissions_by_period = calculate_emissions(energy, utility_factors)

    # Calculate results for each period
    results = {}
    for period in COMPLIANCE_PERIODS:
        emissions = emissions_by_period[period]['total']
        limit = calculate_limit(occupancy_groups, period)
        overage = max(0, emissions - limit)
        penalty = calculate_penalty(emissions, limit)
        compliant = emissions <= limit

        intensity = round(emissions / total_floor_area * 1000, 4) if total_floor_area else 0  # kgCO2e/sf
        limit_intensity = round(limit / total_floor_area * 1000, 4) if total_floor_area else 0

        results[period] = {
            'label':             PERIOD_LABELS[period],
            'emissions':         emissions,
            'limit':             limit,
            'overage':           round(overage, 4),
            'penalty':           penalty,
            'compliant':         compliant,
            'intensity_kg':      intensity,        # kgCO2e/sf/yr
            'limit_intensity_kg': limit_intensity,
            'breakdown':         emissions_by_period[period]['breakdown'],
        }

    # Utility costs
    utility_costs = calculate_utility_costs(energy, prices)

    return jsonify({
        'results':           results,
        'utility_costs':     utility_costs,
        'total_floor_area':  total_floor_area,
        'energy_summary':    energy,
    })


@app.route('/api/espm-types')
def espm_types():
    return jsonify({'types': ESPM_PROPERTY_TYPES})


@app.route('/api/db-status')
def db_status():
    if not os.path.exists(DB_PATH):
        return jsonify({'initialized': False, 'count': 0})
    conn = get_db_connection()
    count = conn.execute('SELECT COUNT(*) FROM buildings').fetchone()[0]
    conn.close()
    return jsonify({'initialized': count > 0, 'count': count})


def _safe_float(val):
    try:
        return float(val) if val not in (None, '') else None
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# CLI: initialize database
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--init-db', action='store_true', help='Download and import LL84 data')
    parser.add_argument('--port', type=int, default=5000)
    args = parser.parse_args()

    if args.init_db:
        print('Initializing LL84 database...')
        import_ll84_data(verbose=True)
    else:
        print(f'Starting LL97 Calculator on http://0.0.0.0:{args.port}')
        print('Run with --init-db to download building database first.')
        app.run(host='0.0.0.0', port=args.port, debug=True)
