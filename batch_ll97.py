"""
Batch LL97 compliance calculator for the full LL84 dataset.

Usage:
    python batch_ll97.py [--year 2024] [--limit 25] [--all]

Outputs a TSV/table of every building with:
    BBL, Address, GFA, Property Type Blend, Emissions(tCO2e),
    Limit(tCO2e), Overage(tCO2e), Annual Penalty($)
"""

import sys
import os
import sqlite3

# ── Pull emission factors directly from the app's data module ──────────────
sys.path.insert(0, os.path.dirname(__file__))
from data.emission_factors import (
    DEFAULT_UTILITY_FACTORS, ESPM_LIMITS, UNIT_CONVERSIONS, PENALTY_RATE
)

DB_PATH = os.path.join(os.path.dirname(__file__), 'll84.db')
PERIOD  = '2024_2029'
FACTORS = DEFAULT_UTILITY_FACTORS[PERIOD]
UC      = UNIT_CONVERSIONS


# ──────────────────────────────────────────────────────────────────────────
# Core helpers (mirror app.py logic, no Flask session dependency)
# ──────────────────────────────────────────────────────────────────────────

def calc_emissions(row):
    """Return tCO2e for the 2024-2029 period."""
    elec_kwh   = row['electricity_kwh']     or 0
    ng_kbtu    = row['natural_gas_kbtu']    or 0
    steam_kbtu = row['district_steam_kbtu'] or 0
    fo2_kbtu   = row['fuel_oil_2_kbtu']     or 0
    fo4_kbtu   = row['fuel_oil_4_kbtu']     or 0

    return (
        elec_kwh   * FACTORS['electricity_kwh']     +
        ng_kbtu    * FACTORS['natural_gas_kbtu']    +
        steam_kbtu * FACTORS['district_steam_kbtu'] +
        fo2_kbtu   * FACTORS['fuel_oil_2_kbtu']     +
        fo4_kbtu   * FACTORS['fuel_oil_4_kbtu']
    )


def calc_limit(row):
    """
    Weighted-blend limit using up to three property-type/area pairs.
    Returns (limit_tCO2e, blend_description).
    """
    groups = []
    for ptype_col, area_col in [
        ('primary_property_type', 'primary_floor_area'),
        ('second_property_type',  'second_floor_area'),
        ('third_property_type',   'third_floor_area'),
    ]:
        ptype = row[ptype_col] or ''
        area  = row[area_col]  or 0
        if ptype and area > 0:
            groups.append((ptype, area))

    # Fallback: if no per-use areas, use gross_floor_area with primary type
    if not groups:
        ptype = row['primary_property_type'] or ''
        area  = row['gross_floor_area'] or 0
        if ptype and area > 0:
            groups.append((ptype, area))

    total_area = sum(a for _, a in groups) or 1
    limit = 0.0
    parts = []
    for ptype, area in groups:
        factor = ESPM_LIMITS.get(ptype, {}).get(PERIOD)
        if factor is None:
            parts.append(f'{ptype}({area:,.0f} sf, NO LIMIT)')
            continue
        contrib = factor * area
        limit  += contrib
        pct     = area / total_area * 100
        parts.append(f'{ptype} {pct:.0f}%@{factor:.5f}')
    blend_desc = ' | '.join(parts) if parts else 'NO TYPES'
    return limit, blend_desc


def calc_penalty(emissions, limit):
    overage = emissions - limit
    if overage <= 0:
        return 0.0, 0.0
    return overage, round(overage * PENALTY_RATE, 2)


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--year',  default='2024', help='Year ending (default 2024)')
    parser.add_argument('--limit', type=int, default=25,
                        help='Max rows to print (default 25; use 0 for all)')
    parser.add_argument('--all',   action='store_true', help='Process entire dataset')
    args = parser.parse_args()

    if not os.path.exists(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        print(f'ERROR: {DB_PATH} is missing or empty. Please upload the ll84.db file.')
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Detect year_ending format in DB
    sample = conn.execute('SELECT year_ending FROM buildings LIMIT 5').fetchall()
    sample_vals = [r[0] for r in sample if r[0]]
    print(f'Sample year_ending values: {sample_vals[:3]}')

    year_filter = args.year  # e.g. '2024'
    # Match both '2024-12-31T00:00:00.000' and plain '2024'
    rows = conn.execute('''
        SELECT * FROM buildings
        WHERE year_ending LIKE ?
        ORDER BY gross_floor_area DESC
    ''', (f'{year_filter}%',)).fetchall()

    total_buildings = len(rows)
    print(f'\nFound {total_buildings:,} buildings with year_ending starting with "{year_filter}"')
    print(f'Period: {PERIOD}  |  Penalty rate: ${PENALTY_RATE}/tCO2e\n')

    display_limit = 0 if args.all else (args.limit if args.limit > 0 else 0)
    display_rows  = rows if display_limit == 0 else rows[:display_limit]

    # Header
    col_w = [8, 35, 10, 50, 12, 12, 12, 14]
    headers = ['BBL', 'Address', 'GFA (sf)', 'Blend (type % @ factor)', 'Emissions', 'Limit', 'Overage', 'Annual Penalty']
    sep = '  '.join('-' * w for w in col_w)
    hdr = '  '.join(h.ljust(w) for h, w in zip(headers, col_w))
    print(sep)
    print(hdr)
    print(sep)

    # Counters for summary
    n_over    = 0
    n_no_type = 0
    total_penalty = 0.0
    total_emissions = 0.0
    total_limit = 0.0

    for row in display_rows:
        emissions      = calc_emissions(row)
        limit, blend   = calc_limit(row)
        overage, penalty = calc_penalty(emissions, limit)

        if limit == 0 and not any(
            row[c] for c in ('primary_property_type','second_property_type','third_property_type')
        ):
            n_no_type += 1

        if penalty > 0:
            n_over += 1

        total_penalty   += penalty
        total_emissions += emissions
        total_limit     += limit

        bbl     = str(row['bbl']     or '')[:col_w[0]]
        addr    = str(row['address'] or '')[:col_w[1]]
        gfa     = f"{(row['gross_floor_area'] or 0):,.0f}"
        blend_s = blend[:col_w[3]]
        em_s    = f"{emissions:,.1f}"
        lim_s   = f"{limit:,.1f}"
        over_s  = f"{overage:,.1f}" if overage > 0 else '—'
        pen_s   = f"${penalty:,.0f}" if penalty > 0 else '—'

        print('  '.join([
            bbl.ljust(col_w[0]),
            addr.ljust(col_w[1]),
            gfa.rjust(col_w[2]),
            blend_s.ljust(col_w[3]),
            em_s.rjust(col_w[4]),
            lim_s.rjust(col_w[5]),
            over_s.rjust(col_w[6]),
            pen_s.rjust(col_w[7]),
        ]))

    print(sep)
    if display_limit and total_buildings > display_limit:
        print(f'(Showing {len(display_rows)} of {total_buildings:,} total buildings — run with --all for full dataset)')
    else:
        print(f'Total buildings shown: {len(display_rows):,}')

    print(f'\nSummary (shown rows):')
    print(f'  Buildings over limit:   {n_over:,} / {len(display_rows):,}')
    print(f'  Total annual penalty:   ${total_penalty:,.0f}')
    print(f'  Avg emissions (tCO2e):  {total_emissions/max(len(display_rows),1):,.1f}')
    print(f'  Buildings w/ no type:   {n_no_type:,}')

    conn.close()


if __name__ == '__main__':
    main()
