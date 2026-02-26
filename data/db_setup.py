"""
Database setup and LL84 data import for LL97 Calculator.
Downloads NYC LL84 benchmarking data from NYC Open Data and stores in SQLite.
Dataset: NYC Building Energy and Water Data Disclosure (2022-Present)
Dataset ID: 5zyy-y8am

To populate the database run:
    python app.py --init-db
or:
    python data/db_setup.py
"""

import sqlite3
import requests
import json
import sys
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'll84.db')
NYC_OPEN_DATA_URL = 'https://data.cityofnewyork.us/resource/5zyy-y8am.json'
APP_TOKEN = ''  # Optional: NYC Open Data app token for higher rate limits
PAGE_SIZE = 1000

# ---------------------------------------------------------------------------
# Column name mappings: the LL84 Socrata API uses these exact field names.
# We provide ordered lists of candidates so the importer auto-detects which
# schema version is present (the 2022-present dataset differs slightly from
# the pre-2022 dataset in some field names).
# ---------------------------------------------------------------------------

# Each entry: (our_internal_name, [candidate_api_names_in_preference_order])
FIELD_MAP = [
    # Identifiers
    ('bbl',                  ['bbl_10_digits', 'bbl']),
    ('property_name',        ['property_name']),
    ('parent_property_name', ['parent_property_name']),
    ('address',              ['address_1_self_reported', 'address1', 'address']),
    ('borough',              ['borough']),
    ('postcode',             ['postcode', 'zip_code']),
    ('year_ending',          ['year_ending', 'reporting_year']),
    # Building characteristics
    ('gross_floor_area',     ['dof_gross_floor_area', 'gross_floor_area_buildings_sq_ft',
                               'largest_property_use_type_gross_floor_area']),
    ('primary_property_type',['largest_property_use_type', 'primary_property_type_self_selected']),
    ('second_property_type', ['second_largest_property_use', 'second_largest_property_use_type']),
    ('third_property_type',  ['third_largest_property_use',  'third_largest_property_use_type']),
    # Energy (all combustion fuels stored in kBtu; electricity in kWh)
    # Electricity — 2022+ dataset reports in kWh
    ('electricity_kwh',      ['electricity_use_grid_purchase',
                               'electricity_use_grid_purchase_k_btu',  # older schema (kBtu—flag for conversion)
                               'electricity_kwh']),
    # Natural gas — stored in kBtu regardless of source unit
    ('natural_gas_kbtu',     ['natural_gas_use_kbtu', 'natural_gas_use_k_btu',
                               'natural_gas_use_therms']),             # therms—flag for conversion
    # District steam — kBtu
    ('district_steam_kbtu',  ['district_steam_use_kbtu', 'district_steam_use_k_btu']),
    # Fuel oils — kBtu
    ('fuel_oil_2_kbtu',      ['fuel_oil_2_use_kbtu', 'fuel_oil_number_2_use_k_btu']),
    ('fuel_oil_4_kbtu',      ['fuel_oil_4_use_kbtu', 'fuel_oil_number_4_use_k_btu']),
    ('fuel_oil_56_kbtu',     ['fuel_oil_5_and_6_use_kbtu', 'fuel_oil_number_5_6_use_k_btu']),
    # Performance metrics
    ('site_eui',             ['site_eui_kbtu_ft', 'site_eui_kbtu_sq_ft', 'weather_normalized_site_eui_kbtu_sq_ft']),
    ('weather_norm_site_eui',['weather_normalized_site_eui', 'weather_normalized_site_eui_kbtu_sq_ft']),
    ('energy_star_score',    ['energy_star_score']),
    ('reported_ghg_emissions',['total_ghg_emissions_metric_tons_co2e', 'total_ghg_emissions']),
    ('reported_ghg_intensity',['ghg_intensity_metric_tons_co2e_ft2', 'ghg_emissions_intensity_metric_tons']),
]

# Fields that might be in kBtu but should be stored as kWh (conversion: /3.412)
_ELEC_KBTU_FIELDS = {'electricity_use_grid_purchase_k_btu'}
# Fields that might be in therms and should be stored as kBtu (* 100)
_GAS_THERM_FIELDS = {'natural_gas_use_therms'}


def _resolve_field(record, candidates):
    """Return (value, source_field) for the first matching candidate in record."""
    for candidate in candidates:
        if candidate in record:
            return record[candidate], candidate
    return None, None


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def create_tables(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bbl TEXT,
            property_name TEXT,
            parent_property_name TEXT,
            address TEXT,
            borough TEXT,
            postcode TEXT,
            year_ending TEXT,
            gross_floor_area REAL,
            primary_property_type TEXT,
            second_property_type TEXT,
            third_property_type TEXT,
            electricity_kwh REAL,
            natural_gas_kbtu REAL,
            district_steam_kbtu REAL,
            fuel_oil_2_kbtu REAL,
            fuel_oil_4_kbtu REAL,
            fuel_oil_56_kbtu REAL,
            site_eui REAL,
            weather_norm_site_eui REAL,
            energy_star_score TEXT,
            reported_ghg_emissions REAL,
            reported_ghg_intensity REAL
        )
    ''')

    conn.execute('''
        CREATE INDEX IF NOT EXISTS idx_bbl ON buildings(bbl)
    ''')
    conn.execute('''
        CREATE INDEX IF NOT EXISTS idx_address ON buildings(address)
    ''')
    conn.execute('''
        CREATE INDEX IF NOT EXISTS idx_property_name ON buildings(property_name)
    ''')
    conn.commit()


def safe_float(val):
    try:
        return float(val) if val not in (None, '', 'Not Available') else None
    except (ValueError, TypeError):
        return None


def _extract_row(record, detected_schema):
    """Extract one DB row from an API record using the detected schema."""
    row = []
    for our_name, candidates in FIELD_MAP:
        raw_val, src_field = _resolve_field(record, candidates)

        if our_name in ('bbl', 'property_name', 'parent_property_name', 'address',
                        'borough', 'postcode', 'year_ending', 'primary_property_type',
                        'second_property_type', 'third_property_type', 'energy_star_score'):
            row.append(raw_val or '')
        elif our_name == 'electricity_kwh':
            val = safe_float(raw_val)
            # Older schema stored electricity in kBtu — convert to kWh
            if val is not None and src_field in _ELEC_KBTU_FIELDS:
                val = round(val / 3.412, 1)
            row.append(val)
        elif our_name == 'natural_gas_kbtu':
            val = safe_float(raw_val)
            # Some schemas report therms — convert to kBtu (* 100)
            if val is not None and src_field in _GAS_THERM_FIELDS:
                val = val * 100
            row.append(val)
        else:
            row.append(safe_float(raw_val))

    return tuple(row)


def import_ll84_data(verbose=True):
    """Download LL84 data from NYC Open Data and import into SQLite."""
    conn = get_db_connection()
    create_tables(conn)

    # Check if data already exists
    count = conn.execute('SELECT COUNT(*) FROM buildings').fetchone()[0]
    if count > 0:
        if verbose:
            print(f'Database already contains {count} buildings. Skipping import.')
            print('To re-import, delete ll84.db and run again.')
        conn.close()
        return count

    if verbose:
        print('Downloading LL84 building data from NYC Open Data...')
        print('This may take a few minutes (~26,000 buildings, ~26 API pages).')

    headers = {}
    if APP_TOKEN:
        headers['X-App-Token'] = APP_TOKEN

    # Fetch first page to detect schema
    try:
        probe = requests.get(NYC_OPEN_DATA_URL,
                             params={'$limit': 1},
                             headers=headers, timeout=20)
        probe.raise_for_status()
        sample = probe.json()
    except Exception as e:
        if verbose:
            print(f'Cannot reach NYC Open Data API: {e}')
            print('Run this script when network access to data.cityofnewyork.us is available.')
        conn.close()
        return 0

    detected_schema = set(sample[0].keys()) if sample else set()
    if verbose and sample:
        print(f'Detected {len(detected_schema)} API columns. Starting import...')

    offset = 0
    total_imported = 0

    while True:
        params = {
            '$limit': PAGE_SIZE,
            '$offset': offset,
            '$order': ':id',  # stable ordering
        }

        try:
            resp = requests.get(NYC_OPEN_DATA_URL, params=params,
                                headers=headers, timeout=60)
            resp.raise_for_status()
            records = resp.json()
        except Exception as e:
            if verbose:
                print(f'\nError at offset {offset}: {e}')
            break

        if not records:
            break

        rows = [_extract_row(r, detected_schema) for r in records]

        conn.executemany('''
            INSERT INTO buildings (
                bbl, property_name, parent_property_name, address, borough,
                postcode, year_ending, gross_floor_area, primary_property_type,
                second_property_type, third_property_type, electricity_kwh,
                natural_gas_kbtu, district_steam_kbtu, fuel_oil_2_kbtu,
                fuel_oil_4_kbtu, fuel_oil_56_kbtu, site_eui,
                weather_norm_site_eui, energy_star_score,
                reported_ghg_emissions, reported_ghg_intensity
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ''', rows)
        conn.commit()

        total_imported += len(records)
        offset += PAGE_SIZE

        if verbose:
            print(f'  Imported {total_imported} buildings...', end='\r', flush=True)

        if len(records) < PAGE_SIZE:
            break

    if verbose:
        print(f'\nImport complete. {total_imported} buildings stored in database.')

    conn.close()
    return total_imported


if __name__ == '__main__':
    import_ll84_data(verbose=True)
