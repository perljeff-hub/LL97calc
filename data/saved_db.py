"""
Saved Buildings database — stores user-defined building snapshots.

This database is entirely separate from ll84.db (which remains read-only).
It is created automatically on first save.
"""

import sqlite3
import os

SAVED_DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'savedbuildings.db')


def get_saved_db_connection():
    conn = sqlite3.connect(SAVED_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def create_saved_tables(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS saved_buildings (
            id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
            save_name           TEXT     UNIQUE NOT NULL,
            saved_at            DATETIME DEFAULT (datetime('now')),
            source_bbl          TEXT,
            source_bin          TEXT,
            property_name       TEXT,
            address             TEXT,
            borough             TEXT,
            postcode            TEXT,
            year_ending         TEXT,
            gross_floor_area    REAL,
            energy_star_score   TEXT,
            electricity_kwh     REAL,
            natural_gas_therms  REAL,
            district_steam_mlb  REAL,
            fuel_oil_2_gal      REAL,
            fuel_oil_4_gal      REAL,
            occupancy_groups    TEXT,
            reported_ghg        REAL
        )
    ''')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_save_name ON saved_buildings(save_name)'
    )
    conn.commit()
