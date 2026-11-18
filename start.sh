#!/bin/sh
# Ezviz Wall launcher for macOS / Linux
# Usage: sh start.sh [--port 8770] [--no-browser]

cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" >/dev/null 2>&1; then
      PY="$c"
      break
    fi
  fi
done

if [ -z "$PY" ]; then
  echo "[ERROR] Python 3.8+ not found."
  echo "        macOS : brew install python3"
  echo "        Ubuntu: sudo apt install python3"
  exit 1
fi

echo "Using: $($PY --version 2>&1)"
echo "Starting Ezviz Wall ..."
exec "$PY" server.py "$@"
