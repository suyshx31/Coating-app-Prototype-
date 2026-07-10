"""Dedicated test stack: throwaway Postgres 17 in Docker + its own API server.

Tests never touch the live Supabase database. A fresh container is created per
session (tmpfs-backed, destroyed on teardown), the schema baseline + reference
data from tests/fixtures/ are applied, and uvicorn is started on port 8002
pointing at it (DATABASE_URL passed via env wins over backend/.env because
load_dotenv does not override existing variables).

Regenerating fixtures after a new migration:
  docker run --rm --network host postgres:17 pg_dump "$DATABASE_URL" \
    --schema=public --schema-only --no-owner --no-privileges > tests/fixtures/schema_baseline.sql
  (and the --data-only dump of the three reference tables, see git history)
"""
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests

BACKEND_DIR = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
PG_CONTAINER = "coating-test-pg"
PG_PORT = 55432
API_PORT = 8002
TEST_DB_URL = f"postgresql://postgres:test@localhost:{PG_PORT}/postgres"


@pytest.fixture(scope="session", autouse=True)
def test_stack():
    # fresh container (remove any leftover from an aborted run)
    subprocess.run(["docker", "rm", "-f", PG_CONTAINER], capture_output=True)
    subprocess.run(
        ["docker", "run", "-d", "--name", PG_CONTAINER,
         "-e", "POSTGRES_PASSWORD=test",
         "-p", f"{PG_PORT}:5432",
         "--tmpfs", "/var/lib/postgresql/data",
         "postgres:17"],
        check=True, capture_output=True,
    )
    for _ in range(60):
        r = subprocess.run(["docker", "exec", PG_CONTAINER, "pg_isready", "-U", "postgres"],
                           capture_output=True)
        if r.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("test postgres never became ready")

    for sql_file in ("schema_baseline.sql", "reference_data.sql"):
        sql = (FIXTURES / sql_file).read_bytes()
        r = subprocess.run(
            ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
            input=sql, capture_output=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"applying {sql_file} failed: {r.stderr.decode()[:800]}")

    env = {**os.environ, "DATABASE_URL": TEST_DB_URL}
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app", "--port", str(API_PORT)],
        cwd=BACKEND_DIR, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(30):
            try:
                if requests.get(f"http://localhost:{API_PORT}/api/", timeout=2).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("test API server never became ready")
        yield
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        subprocess.run(["docker", "rm", "-f", PG_CONTAINER], capture_output=True)
