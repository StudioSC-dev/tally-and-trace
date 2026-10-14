#!/usr/bin/env python3
"""Run the read-only cutover check against frozen figures (STU-204).

    DATABASE_URL=... python backend/scripts/cutover_check.py \\
        --frozen PATH --report PATH \\
        --expect-host HOST --expect-db NAME --expect-server-addr ADDR

The URL is read from the environment only. Paths are resolved against the
directory you run it from, then the process moves into an empty temporary
directory before any app module is imported, so no ``.env`` is ever read.
Exit codes: 0 pass, 1 a blocking check failed, 2 refused before checking.
See docs/cutover-check.md.
"""

import argparse
import os
import sys


def _bootstrap_module():
    backend = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from app.cutover_check import bootstrap

    return bootstrap


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Read-only cutover check")
    parser.add_argument("--frozen", required=True, help="cutover-frozen v1 JSON (outside the repo)")
    parser.add_argument("--report", required=True, help="new report path (outside the repo)")
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    parser.add_argument("--expect-server-addr", required=True)
    args = parser.parse_args(argv)

    bootstrap = _bootstrap_module()
    try:
        frozen_path = bootstrap.require_outside_repo(bootstrap.absolute(args.frozen), "--frozen")
        report_path = bootstrap.require_outside_repo(bootstrap.absolute(args.report), "--report")
        if os.path.exists(report_path):
            raise bootstrap.BootstrapError("--report already exists; choose a new path")
        bootstrap.hermetic()
        url = bootstrap.validate_url(os.environ.get("DATABASE_URL"), args.expect_host,
                                     args.expect_db, os.environ)
    except bootstrap.BootstrapError as exc:
        print(f"refused: {exc}")
        return 2
    print(bootstrap.target_line(url))

    # Only now: the rest of the app (settings read the environment, never a .env).
    from app.cutover_check import check, schema

    try:
        frozen = schema.load_frozen(frozen_path)
        report = check.run(url, frozen, expect_db=args.expect_db,
                           expect_server_addr=args.expect_server_addr,
                           frozen_digest=check.frozen_sha256(frozen_path))
    except (bootstrap.BootstrapError, check.CheckRefused, schema.FrozenError) as exc:
        print(f"refused: {exc}")
        return 2
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    print(f"server: db={report['database']} addr={report['server_addr']}")
    bootstrap.create_private(report_path, check.dump(report) + "\n")
    for line in check.summary_lines(report):
        print(line)
    return 0 if report["overall"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
