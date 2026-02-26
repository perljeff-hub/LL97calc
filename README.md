# NYC LL97 Carbon Emissions Calculator

A web application for estimating NYC Local Law 97 greenhouse gas emissions and penalties for covered buildings.

## Features

- **Building lookup** — Search the NYC LL84 benchmarking database (~26,000 buildings) by address, property name, or BBL to auto-populate energy data
- **Full ESPM support** — All 60 Energy Star Portfolio Manager property types with emission intensity limits for every compliance period (2024–2050+)
- **Multi-period results** — Side-by-side compliance cards for 2024–2029, 2030–2034, 2035–2039, 2040–2049, and 2050+
- **Mixed occupancy** — Up to 4 ESPM property types per building with individual floor areas
- **Utility cost analysis** — Annual cost breakdown by energy source with configurable prices
- **Settings** — Customize utility GHG emission coefficients for future periods (2035–2050+)

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. (First time only) Download the ~26,000-building LL84 database
python app.py --init-db

# 3. Start the server
python app.py

# Or use the startup script:
./run.sh --init-db   # first time
./run.sh             # subsequent runs
```

Open [http://localhost:5000](http://localhost:5000) in your browser.

## Data Sources

| Source | Description |
|--------|-------------|
| [NYC LL84 Benchmarking Data](https://data.cityofnewyork.us/Environment/NYC-Building-Energy-and-Water-Data-Disclosure-for-/5zyy-y8am) | Annual energy & water use for buildings >25,000 sf |
| [1 RCNY §103-14](https://rules.cityofnewyork.us/rule/procedures-for-reporting-on-and-complying-with-annual-greenhouse-gas-emissions/) | Official GHG emission factors and ESPM intensity limits |
| [NYC Admin. Code §28-320](https://www.nyc.gov/site/buildings/codes/ll97-greenhouse-gas-emissions-reductions.page) | Article 320 occupancy group limits and penalty rate |

## Calculation Methodology

**Annual GHG Emissions** = Σ (fuel consumption × GHG coefficient)

| Fuel | Input Unit | GHG Coefficient (2024–2029) |
|------|-----------|----------------------------|
| Electricity | kWh | 0.000288962 tCO₂e/kWh |
| Natural Gas | therms | 0.00005311 tCO₂e/kBtu × 100 kBtu/therm |
| District Steam | Mlb | 0.00004493 tCO₂e/kBtu × 1,194 kBtu/Mlb |
| #2 Fuel Oil | gallons | 0.00007421 tCO₂e/kBtu × 138.5 kBtu/gal |
| #4 Fuel Oil | gallons | 0.00007529 tCO₂e/kBtu × 146.0 kBtu/gal |

**Building Emissions Limit** = Σ (floor area × ESPM intensity factor) across all occupancy types

**Annual Penalty** = max(0, Emissions − Limit) × $268/tCO₂e

### GHG Coefficients by Period

| Period | Electricity | Natural Gas | District Steam |
|--------|------------|-------------|----------------|
| 2024–2029 | 0.000288962 tCO₂e/kWh | 0.00005311 tCO₂e/kBtu | 0.00004493 tCO₂e/kBtu |
| 2030–2034 | 0.000145 tCO₂e/kWh | 0.00005311 tCO₂e/kBtu | 0.0000432 tCO₂e/kBtu |
| 2035–2049 | Configurable (default: 2030 values) | | |
| 2050+ | 0 (required by law) | | |

## Project Structure

```
LL97calc/
├── app.py                  # Flask application + API endpoints
├── requirements.txt
├── run.sh                  # Startup script
├── data/
│   ├── emission_factors.py # All LL97 emission factors & ESPM limits
│   └── db_setup.py         # LL84 database setup & import
├── templates/
│   ├── index.html          # Main calculator page
│   └── settings.html       # Emission factor settings
└── static/
    ├── css/style.css
    └── js/calculator.js
```

## Notes

- This calculator covers **Article 320** buildings only (all buildings >25,000 sf that are not Article 321 buildings)
- For 2024–2025, owners may optionally use the original NYC Building Code occupancy group limits if they are more favorable than the ESPM limits; from 2026 onward, ESPM property types are required
- ESPM intensity limits for 2035–2039 and 2040–2049 are taken from 1 RCNY §103-14; utility emission coefficients for these periods default to the 2030–2034 values and are user-configurable in the Settings tab
- This tool is for estimation purposes only and is not a substitute for professional compliance advice

## License

MIT
