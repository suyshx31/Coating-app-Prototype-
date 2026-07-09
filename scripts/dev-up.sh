#!/usr/bin/env bash
# dev-up: start the whole Coating Portal dev stack with one command.
#   1. verifies Supabase Postgres is reachable (DATABASE_URL in backend/.env)
#   2. starts the FastAPI backend on :8001 (creates venv + installs deps if missing)
#   3. points frontend/.env at this machine's current LAN IP (it changes with DHCP)
#   4. starts Expo in the foreground — Ctrl+C stops Expo AND the backend
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
PORT=8001

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# ---- 1. backend env + DB reachability ----
say "Checking backend/.env"
if ! grep -q '^DATABASE_URL=' "$BACKEND/.env" 2>/dev/null; then
  echo "ERROR: DATABASE_URL missing from backend/.env (Supabase direct connection string)." >&2
  exit 1
fi

if [ ! -x "$BACKEND/venv/bin/python" ]; then
  say "Creating backend venv + installing deps (first run)"
  python3 -m venv "$BACKEND/venv"
  # emergentintegrations is a private index package unused by server.py — skip it
  grep -v '^emergentintegrations' "$BACKEND/requirements.txt" | "$BACKEND/venv/bin/pip" install -q -r /dev/stdin
fi

say "Checking Supabase Postgres connection"
export BACKEND_DIR="$BACKEND"
"$BACKEND/venv/bin/python" - <<'PY'
import asyncio, os, sys
from dotenv import load_dotenv
import asyncpg
load_dotenv(os.path.join(os.environ["BACKEND_DIR"], ".env"))
async def main():
    try:
        conn = await asyncpg.connect(os.environ["DATABASE_URL"], timeout=10)
        await conn.close()
        print("Supabase Postgres: reachable")
    except Exception as e:
        print(f"ERROR: cannot reach Supabase Postgres: {e}", file=sys.stderr)
        sys.exit(1)
asyncio.run(main())
PY

# ---- 2. backend ----
say "Starting backend on :$PORT"
if curl -sf "http://localhost:$PORT/api/" >/dev/null 2>&1; then
  echo "Backend already running — leaving it as is."
  UVICORN_PID=""
else
  (cd "$BACKEND" && exec ./venv/bin/uvicorn server:app --host 0.0.0.0 --port "$PORT") &
  UVICORN_PID=$!
  for _ in $(seq 1 30); do
    curl -sf "http://localhost:$PORT/api/" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://localhost:$PORT/api/" >/dev/null || { echo "ERROR: backend failed to start" >&2; exit 1; }
  echo "Backend up: http://localhost:$PORT/api/"
fi

# ---- 3. frontend env: current LAN IP so phones on the same Wi-Fi reach the API ----
say "Updating frontend/.env with current LAN IP"
LAN_IP="$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '^127\.' | grep -v '^172\.17\.' | head -1)"
if [ -z "$LAN_IP" ]; then
  echo "WARNING: no LAN IP found; keeping existing frontend/.env" >&2
else
  echo "EXPO_PUBLIC_BACKEND_URL=http://$LAN_IP:$PORT" > "$FRONTEND/.env"
  echo "EXPO_PUBLIC_BACKEND_URL=http://$LAN_IP:$PORT"
fi

# ---- 4. expo (foreground; Ctrl+C tears everything down) ----
if [ ! -d "$FRONTEND/node_modules" ]; then
  say "Installing frontend deps (first run)"
  (cd "$FRONTEND" && npm install --legacy-peer-deps)
fi

cleanup() {
  if [ -n "${UVICORN_PID:-}" ]; then
    say "Stopping backend"
    pkill -f "uvicorn server:app.*$PORT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

say "Starting Expo (scan the QR with Expo Go)"
cd "$FRONTEND" && npx expo start -c
