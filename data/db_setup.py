"""
Database setup and LL84 data import for LL97 Calculator.
Downloads NYC LL84 benchmarking data from NYC Open Data and stores in SQLite.
Dataset: NYC Building Energy and Water Data Disclosure (2022-Present)
Dataset ID: 5zyy-y8am
"""

import sqlite3
import requests
import json
import sys
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'll84.db')
NYC_OPEN_DATA_URL = 'https://data.cityofnewyork.us/resource/5zyy-y8am.json'
APP_TOKEN = ''  # Optional: set NYC Open Data app token here for higher rate limits
PAGE_SIZE = 1000

# Columns to import from the LL84 dataset
# These are the Socrata API field names (lowercase with underscores)
COLUMNS_TO_FETCH = [
    'bbl_10_digits',
    'property_name',
    'parent_property_name',
    'address_1_self_reported',
    'borough',
    'postcode',
    'year_ending',
    'dof_gross_floor_area',
    'largest_property_use_type',
    'second_largest_property_use',
    'third_largest_property_use',
    'electricity_use_grid_purchase',    # kWh
    'natural_gas_use_kbtu',             # kBtu
    'district_steam_use_kbtu',          # kBtu
    'fuel_oil_2_use_kbtu',              # kBtu
    'fuel_oil_4_use_kbtu',              # kBtu
    'fuel_oil_5_and_6_use_kbtu',        # kBtu (combined)
    'site_eui_kbtu_ft',                 # Site EUI
    'weather_normalized_site_eui',
    'energy_star_score',
    'total_ghg_emissions_metric_tons_co2e',
    'ghg_intensity_metric_tons_co2e_ft2',
]


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
        print('This may take a few minutes for ~26,000 buildings.')

    headers = {}
    if APP_TOKEN:
        headers['X-App-Token'] = APP_TOKEN

    offset = 0
    total_imported = 0

    while True:
        params = {
            '$limit': PAGE_SIZE,
            '$offset': offset,
            '$order': 'bbl_10_digits ASC',
        }

        try:
            resp = requests.get(NYC_OPEN_DATA_URL, params=params, headers=headers, timeout=30)
            resp.raise_for_status()
            records = resp.json()
        except Exception as e:
            if verbose:
                print(f'Error fetching data at offset {offset}: {e}')
            break

        if not records:
            break

        rows = []
        for r in records:
            row = (
                r.get('bbl_10_digits', ''),
                r.get('property_name', ''),
                r.get('parent_property_name', ''),
                r.get('address_1_self_reported', ''),
                r.get('borough', ''),
                r.get('postcode', ''),
                r.get('year_ending', ''),
                safe_float(r.get('dof_gross_floor_area')),
                r.get('largest_property_use_type', ''),
                r.get('second_largest_property_use', ''),
                r.get('third_largest_property_use', ''),
                safe_float(r.get('electricity_use_grid_purchase')),
                safe_float(r.get('natural_gas_use_kbtu')),
                safe_float(r.get('district_steam_use_kbtu')),
                safe_float(r.get('fuel_oil_2_use_kbtu')),
                safe_float(r.get('fuel_oil_4_use_kbtu')),
                safe_float(r.get('fuel_oil_5_and_6_use_kbtu')),
                safe_float(r.get('site_eui_kbtu_ft')),
                safe_float(r.get('weather_normalized_site_eui')),
                r.get('energy_star_score', ''),
                safe_float(r.get('total_ghg_emissions_metric_tons_co2e')),
                safe_float(r.get('ghg_intensity_metric_tons_co2e_ft2')),
            )
            rows.append(row)

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
            print(f'  Imported {total_imported} buildings...', end='\r')

        if len(records) < PAGE_SIZE:
            break

    if verbose:
        print(f'\nImport complete. {total_imported} buildings stored in database.')

    conn.close()
    return total_imported


if __name__ == '__main__':
    import_ll84_data(verbose=True)
