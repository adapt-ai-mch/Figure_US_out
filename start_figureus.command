#!/bin/bash
# FigureUS(out): double-click in Finder (or run ./start_figureus.command) to start it on this computer.
# The first start sets up Python (needs the internet once); later starts work offline.
cd "$(dirname "$0")" || exit 1

if [ ! -x .venv/bin/python ]; then
  echo "First start: setting up Python in .venv (needs the internet this once)..."
  python3 -m venv .venv || { echo "Python 3.10 or newer is needed: https://www.python.org/downloads/"; read -r -p "Press Return to close."; exit 1; }
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt || { read -r -p "Installation failed. Press Return to close."; exit 1; }
fi

if ! .venv/bin/python -c "import fastapi, uvicorn, multipart" 2>/dev/null; then
  echo "Adding the server packages (needs the internet this once)..."
  .venv/bin/python -m pip install -r requirements.txt || { read -r -p "Installation failed. Press Return to close."; exit 1; }
fi

if [ ! -f gui/dist/index.html ]; then
  echo "The built GUI (gui/dist) is missing. Build it with Node 20 or newer:"
  echo "  npm --prefix gui install && npm --prefix gui run build"
  read -r -p "Press Return to close."
  exit 1
fi

exec .venv/bin/python server/app.py "$@"
