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
            reported_ghg        REAL,
            selected_scenario_id INTEGER DEFAULT NULL,
            compliance_cache    TEXT    DEFAULT NULL
        )
    ''')
    # Migrate: add new columns if the table already exists without them
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(saved_buildings)").fetchall()}
    if 'selected_scenario_id' not in existing_cols:
        conn.execute('ALTER TABLE saved_buildings ADD COLUMN selected_scenario_id INTEGER DEFAULT NULL')
    if 'compliance_cache' not in existing_cols:
        conn.execute('ALTER TABLE saved_buildings ADD COLUMN compliance_cache TEXT DEFAULT NULL')
    if 'deleted' not in existing_cols:
        conn.execute('ALTER TABLE saved_buildings ADD COLUMN deleted INTEGER DEFAULT 0')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_save_name ON saved_buildings(save_name)'
    )

    # ── Reduction Plan tables ────────────────────────────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS measures (
            id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
            building_save_name  TEXT     NOT NULL,
            name                TEXT     NOT NULL,
            cost                REAL     DEFAULT 0,
            elec_savings        REAL     DEFAULT 0,
            gas_savings         REAL     DEFAULT 0,
            steam_savings       REAL     DEFAULT 0,
            oil2_savings        REAL     DEFAULT 0,
            oil4_savings        REAL     DEFAULT 0,
            created_at          DATETIME DEFAULT (datetime('now'))
        )
    ''')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_measures_building ON measures(building_save_name)'
    )

    conn.execute('''
        CREATE TABLE IF NOT EXISTS scenarios (
            id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
            building_save_name  TEXT     NOT NULL,
            name                TEXT     NOT NULL,
            number              INTEGER  NOT NULL,
            created_at          DATETIME DEFAULT (datetime('now')),
            updated_at          DATETIME DEFAULT (datetime('now'))
        )
    ''')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_scenarios_building ON scenarios(building_save_name)'
    )

    conn.execute('''
        CREATE TABLE IF NOT EXISTS scenario_measures (
            id          INTEGER  PRIMARY KEY AUTOINCREMENT,
            scenario_id INTEGER  NOT NULL,
            measure_id  INTEGER  NOT NULL,
            year        INTEGER  NOT NULL
        )
    ''')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_sm_scenario ON scenario_measures(scenario_id)'
    )

    # ── Real Performance Over Time table ────────────────────────────────────────
    conn.execute('''
        CREATE TABLE IF NOT EXISTS performance_history (
            id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
            building_save_name  TEXT     NOT NULL,
            calendar_year       INTEGER  NOT NULL,
            source_type         TEXT     NOT NULL DEFAULT 'manual',
            ll84_bbl            TEXT,
            ll84_bin            TEXT,
            ll84_year_ending    TEXT,
            override_emissions  REAL,
            override_fine       REAL,
            created_at          DATETIME DEFAULT (datetime('now')),
            updated_at          DATETIME DEFAULT (datetime('now')),
            UNIQUE(building_save_name, calendar_year)
        )
    ''')
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_ph_building ON performance_history(building_save_name)'
    )
    # Migrate: add ll84_bin if the table already exists without it
    ph_cols = {row[1] for row in conn.execute("PRAGMA table_info(performance_history)").fetchall()}
    if 'll84_bin' not in ph_cols:
        conn.execute('ALTER TABLE performance_history ADD COLUMN ll84_bin TEXT')

    conn.commit()
