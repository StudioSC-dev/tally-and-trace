#!/usr/bin/env python3
"""Benchmark the hot endpoints on the realistic dataset (STU-596).

    DATABASE_URL=postgresql://USER:PASS@127.0.0.1:PORT/tt_test_NAME \\
        python backend/scripts/perf_bench.py [--cpu both|full|limited] [--runs 5]

The database must be a local throwaway one (``tt_test_<name>`` on 127.0.0.1 or
localhost, the rule ``app/tests/_db_guard.py`` enforces for the test suite), already
migrated (``alembic upgrade head``) and empty of transactions: the script seeds the
realistic dataset (``app/tests/fixtures/realistic.py``) as new users, so use a fresh
database for every run. The URL is read from the environment only. A URL that fails
the guard ends the run with exit code 2 before any database driver is loaded.

It measures, in-process:

* per hot endpoint, as the owner: SQL statements, response bytes (ids normalised),
  ``statement_day`` calls, ORM instances loaded, CPU time and wall time;
* the Transactions page-open set and the post-save refetch set, fired concurrently
  at a real uvicorn server on a local port: total wall time and total CPU time;
* the repeat page open: the page-open set again with no write in between, each
  request sending the ``ETag`` its previous answer carried as ``If-None-Match``, as
  the browser's cache does (STU-602); the table shows how many were answered 304.

``--cpu both`` (the default) runs the measurement twice: at full CPU, and in a
``systemd-run --user --scope -p CPUQuota=10%`` scope, which is about what Render's
free instance gives. The dataset is seeded once, at full CPU, before either run.
It prints a markdown table to paste into a PR. Counts are exact and repeat; times
are for comparing a before and an after on the same machine.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

BACKEND = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
CPU_QUOTA = "10%"


def _guard() -> int:
    """0 when DATABASE_URL names a local throwaway database, else 2. Stdlib only: no
    driver or app module is imported before this passes."""
    if BACKEND not in sys.path:
        sys.path.insert(0, BACKEND)
    from app.tests import _db_guard

    reason = _db_guard.check_environment() or _db_guard.check_test_database_url(
        os.environ.get("DATABASE_URL", ""))
    if reason:
        print(f"refusing: {reason}", file=sys.stderr)
        return 2
    os.environ["TT_DISABLE_DOTENV"] = "1"
    return 0


def _seed(state_path: str) -> int:
    from fastapi.testclient import TestClient

    from app.core.database import SessionLocal
    from app.main import app
    from app.models.transaction import Transaction
    from app.tests.fixtures.realistic import build_realistic

    db = SessionLocal()
    try:
        if db.query(Transaction.id).first() is not None:
            print("refusing: the database already holds transactions; use a fresh "
                  "throwaway database for each run", file=sys.stderr)
            return 2
        with TestClient(app) as client:
            world = build_realistic(client, db, date.today(), tag="bench")
    finally:
        db.close()
    with open(state_path, "w") as f:
        json.dump(world.to_state(), f)
    print(f"seeded {world.transaction_count} transactions in {world.build_seconds:.1f} s",
          file=sys.stderr)
    return 0


def _serve():
    """The app on a local port in a thread of this process; returns (server, thread, url)."""
    import socket

    import uvicorn

    from app.main import app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                           log_level="warning", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 30
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("uvicorn did not start")
        time.sleep(0.05)
    return server, thread, f"http://127.0.0.1:{port}"


def _concurrent(base_url: str, headers, paths: dict, rounds: int) -> dict:
    """Fire every path at once ``rounds`` times; the median total wall and process time."""
    import httpx

    walls, cpus = [], []
    with httpx.Client(base_url=base_url, timeout=300) as http:
        def get(path):
            r = http.get(f"/api/v1{path}", headers=headers)
            assert r.status_code == 200, (path, r.status_code)

        with ThreadPoolExecutor(max_workers=len(paths)) as pool:
            list(pool.map(get, paths.values()))  # warm
            for _ in range(rounds):
                w0, c0 = time.perf_counter(), time.process_time()
                list(pool.map(get, paths.values()))
                cpus.append((time.process_time() - c0) * 1000)
                walls.append((time.perf_counter() - w0) * 1000)
    return {"requests": len(paths), "wall_ms": statistics.median(walls),
            "cpu_ms": statistics.median(cpus)}


def _repeat_open(base_url: str, headers, paths: dict, rounds: int) -> dict:
    """The page-open set revalidated: each path sends its last ``ETag`` back as
    ``If-None-Match``. The median total wall and process time, and the 304 count of
    the last round."""
    import httpx

    walls, cpus = [], []
    tags: dict = {}
    statuses: dict = {}
    with httpx.Client(base_url=base_url, timeout=300) as http:
        def get(path):
            sent = dict(headers)
            if tags.get(path):
                sent["If-None-Match"] = tags[path]
            r = http.get(f"/api/v1{path}", headers=sent)
            assert r.status_code in (200, 304), (path, r.status_code)
            statuses[path] = r.status_code
            if r.headers.get("etag"):
                tags[path] = r.headers["etag"]

        with ThreadPoolExecutor(max_workers=len(paths)) as pool:
            list(pool.map(get, paths.values()))  # the first open: fills the tags
            for _ in range(rounds):
                w0, c0 = time.perf_counter(), time.process_time()
                list(pool.map(get, paths.values()))
                cpus.append((time.process_time() - c0) * 1000)
                walls.append((time.perf_counter() - w0) * 1000)
    return {"requests": len(paths), "wall_ms": statistics.median(walls),
            "cpu_ms": statistics.median(cpus),
            "not_modified": sum(1 for c in statuses.values() if c == 304)}


def _measure(state_path: str, runs: int) -> int:
    """Child: measure and print one JSON document on stdout."""
    from dataclasses import asdict

    from fastapi.testclient import TestClient

    from app.main import app
    from app.tests.fixtures import perf
    from app.tests.fixtures.realistic import PASSWORD, Realistic

    with open(state_path) as f:
        state = json.load(f)
    result = {}
    with TestClient(app) as client:
        world = Realistic.from_state(state, client)
        headers = world.callers["owner"].headers
        result["endpoints"] = {
            name: asdict(perf.measure(client, headers, path, runs=runs))
            for name, path in perf.hot_paths(world, "owner").items()}
    server, thread, url = _serve()
    try:
        import httpx

        login = httpx.post(f"{url}/api/v1/auth/login", json={
            "email": state["callers"]["owner"]["email"],
            "password": PASSWORD})
        assert login.status_code == 200, login.text
        auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
        result["page_open"] = _concurrent(url, auth, perf.page_open_paths(world), runs)
        result["post_save"] = _concurrent(url, auth, perf.post_save_paths(world), runs)
        result["repeat_open"] = _repeat_open(url, auth, perf.page_open_paths(world), runs)
    finally:
        server.should_exit = True
        thread.join(timeout=15)
    print(json.dumps(result))
    return 0


def _run_child(state_path: str, runs: int, limited: bool) -> dict:
    cmd = [sys.executable, os.path.realpath(__file__), "--measure", state_path,
           "--runs", str(runs)]
    if limited:
        cmd = ["systemd-run", "--user", "--scope", "--quiet", "-p", f"CPUQuota={CPU_QUOTA}",
               *cmd]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.stderr.write(out.stderr[-3000:])
        raise SystemExit(f"measurement failed (exit {out.returncode})")
    return json.loads(out.stdout.strip().splitlines()[-1])


def _table(results: dict) -> str:
    """Markdown for ``{"full": result, "limited": result}`` (either may be absent)."""
    levels = list(results)
    first = results[levels[0]]
    head = ["endpoint", "SQL", "bytes", "statement_day", "instances"]
    for lv in levels:
        head += [f"CPU ms ({lv})", f"wall ms ({lv})"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for name, s in first["endpoints"].items():
        cells = [name, s["statements"], f"{s['bytes']:,}", f"{s['statement_day']:,}",
                 f"{s['instances']:,}"]
        for lv in levels:
            e = results[lv]["endpoints"][name]
            cells += [f"{e['cpu_ms']:.0f}", f"{e['wall_ms']:.0f}"]
        lines.append("| " + " | ".join(str(c) for c in cells) + " |")
    lines += ["", "| request set | requests | " + " | ".join(
        f"wall ms ({lv}) | CPU ms ({lv})" for lv in levels) + " |",
        "|" + "---|" * (2 + 2 * len(levels))]
    for key, label in (("page_open", "Transactions page open"), ("post_save", "after one save"),
                       ("repeat_open", "repeat page open, no write")):
        if key not in first:
            continue
        cells = [label, first[key]["requests"]]
        if "not_modified" in first[key]:
            cells[1] = f"{first[key]['requests']} ({first[key]['not_modified']} × 304)"
        for lv in levels:
            cells += [f"{results[lv][key]['wall_ms']:.0f}", f"{results[lv][key]['cpu_ms']:.0f}"]
        lines.append("| " + " | ".join(str(c) for c in cells) + " |")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--cpu", choices=("both", "full", "limited"), default="both")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--measure", metavar="STATE", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    code = _guard()
    if code:
        return code
    if args.measure:
        return _measure(args.measure, args.runs)
    if args.cpu != "full" and shutil.which("systemd-run") is None:
        print("refusing: systemd-run is not available; use --cpu full", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        state_path = os.path.join(tmp, "state.json")
        code = _seed(state_path)
        if code:
            return code
        results = {}
        if args.cpu in ("both", "full"):
            results["full"] = _run_child(state_path, args.runs, limited=False)
        if args.cpu in ("both", "limited"):
            results["limited"] = _run_child(state_path, args.runs, limited=True)
    print(f"Realistic dataset on {date.today()}, owner, median of {args.runs} runs; "
          f"limited = CPUQuota={CPU_QUOTA}\n")
    print(_table(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
