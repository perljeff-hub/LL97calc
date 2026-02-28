#!/bin/bash
# LL97 Calculator – startup script
#
# Usage:
#   ./run.sh --local          – development server on localhost:5000
#   ./run.sh --prod           – production server with gunicorn (uses $PORT env var)
#   ./run.sh --local --init-db – download LL84 data, then start dev server
#   ./run.sh --prod  --init-db – download LL84 data, then start production server

set -e

# Install dependencies if needed
if ! python3 -c "import flask" 2>/dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

# Parse flags
MODE=""
INIT_DB=0
for arg in "$@"; do
    case "$arg" in
        --local) MODE="local" ;;
        --prod)  MODE="prod"  ;;
        --init-db) INIT_DB=1 ;;
    esac
done

if [[ -z "$MODE" ]]; then
    echo "Usage: ./run.sh [--local | --prod] [--init-db]"
    echo ""
    echo "  --local     Development server on http://localhost:5000"
    echo "  --prod      Production server with gunicorn (reads PORT env var)"
    echo "  --init-db   Download/refresh NYC LL84 building data before starting"
    exit 1
fi

if [[ "$INIT_DB" -eq 1 ]]; then
    echo "Downloading NYC LL84 building data (~26,000 buildings)..."
    python3 app.py --init-db
fi

if [[ "$MODE" == "local" ]]; then
    echo "Starting LL97 Calculator (development) at http://localhost:5000"
    python3 app.py --port 5000
elif [[ "$MODE" == "prod" ]]; then
    PORT="${PORT:-10000}"
    WORKERS="${WEB_CONCURRENCY:-4}"
    echo "Starting LL97 Calculator (production) on port $PORT with $WORKERS workers"
    exec gunicorn -w "$WORKERS" -b "0.0.0.0:$PORT" --timeout 120 app:app
fi
