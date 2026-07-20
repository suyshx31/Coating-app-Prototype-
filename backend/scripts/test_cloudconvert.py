"""Standalone CloudConvert API-key diagnostic — no report logic involved.

Loads CLOUDCONVERT_API_KEY exactly like server.py (environment, with
backend/.env loaded if present) and probes two endpoints:

  1. GET /v2/users/me   — auth check (needs the "user.read" scope)
  2. GET /v2/tasks?per_page=1 — fallback (needs "task.read", the scope the
     conversion flow actually uses), in case the key was created without
     user.read: a 403 on #1 with a 200 here still means the key is VALID.

Interpretation:
  200            -> key valid (and, on /users/me, shows remaining credits)
  401            -> key invalid/revoked/malformed (wrong value in env var)
  403            -> key valid but missing that scope
  402 / 429      -> account payment required / rate or quota exceeded

Run on Railway (where the key lives):  railway run python scripts/test_cloudconvert.py
or locally after adding CLOUDCONVERT_API_KEY to backend/.env.
"""
import json
import os
import sys

import requests

try:  # match server.py, which loads backend/.env on startup
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
except ImportError:
    pass

API = "https://api.cloudconvert.com/v2"


def main() -> int:
    api_key = os.environ.get("CLOUDCONVERT_API_KEY", "")
    preview = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "TOO_SHORT"
    print(f"[CLOUDCONVERT DEBUG] key present: {bool(api_key)}, length: {len(api_key)}, preview: {preview}")
    if not api_key:
        print("FAIL: CLOUDCONVERT_API_KEY is not set in this environment.")
        return 1

    headers = {"Authorization": f"Bearer {api_key}"}
    ok = False
    for label, url in (("users/me (auth check)", f"{API}/users/me"),
                       ("tasks?per_page=1 (task.read scope)", f"{API}/tasks?per_page=1")):
        try:
            r = requests.get(url, headers=headers, timeout=30)
        except requests.RequestException as e:
            print(f"{label}: request failed: {e}")
            continue
        print(f"\n{label}: HTTP {r.status_code}")
        try:
            print(json.dumps(r.json(), indent=2)[:2000])
        except ValueError:
            print(r.text[:2000])
        if r.status_code == 200:
            ok = True
            if "users/me" in url:
                credits = (r.json().get("data") or {}).get("credits")
                print(f"--> key VALID; remaining credits: {credits}")
        elif r.status_code == 401:
            print("--> key INVALID (bad/revoked value in the env var)")
        elif r.status_code == 403:
            print("--> key valid but MISSING this endpoint's scope")
        elif r.status_code in (402, 429):
            print("--> key valid but account is payment-blocked or rate/quota-limited")

    print(f"\nOVERALL: {'KEY WORKS' if ok else 'KEY NOT USABLE — see codes above'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
