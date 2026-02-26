#!/bin/bash
# LL97 Calculator – startup script
# Usage:
#   ./run.sh           – start the server (assumes DB already populated)
#   ./run.sh --init-db – download LL84 data then start the server

set -e

# Install dependencies if needed
if ! python3 -c "import flask" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

if [[ "$1" == "--init-db" ]]; then
    echo "Downloading NYC LL84 building data (~26,000 buildings)..."
    python3 app.py --init-db
fi

echo "Starting LL97 Calculator at http://localhost:5000"
python3 app.py --port 5000
