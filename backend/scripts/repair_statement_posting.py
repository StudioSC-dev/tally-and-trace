#!/usr/bin/env python3
"""List what the posted-date rule moves, and repair named rows' posted day.

    DATABASE_URL=... python backend/scripts/repair_statement_posting.py \\
        --expect-host HOST --expect-db NAME [--txn-id ID ...]   (dry run: writes nothing)
    ... --txn-id ID --apply                                     (writes)

The URL is read from the environment only. Before any app module is imported
the process moves into an empty temporary directory, so no ``.env`` is ever
read, and ``DATABASE_URL`` must name exactly ``--expect-host`` and
``--expect-db`` (the cutover check's rules, ``app/cutover_check/bootstrap.py``).
The report first lists every posted card row whose statement close changes
under the posted-date rule and every unposted row that rolls, then each named
row's repair (its ``posting_date`` set to its own day). Without ``--apply``
every repair is made and checked inside the transaction, then rolled back.
The output lists ids, dates and refusal reasons, never an amount. Exit codes:
0 done (refused rows are listed and left unchanged), 1 an error (nothing more
is written), 2 refused before connecting. See
``app/services/statement_posting_repair.py``.
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
    parser = argparse.ArgumentParser(
        description="List rows the posted-date rule moves; repair named rows' posted day")
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    parser.add_argument("--txn-id", type=int, action="append", default=[],
                        help="a row to repair (repeatable); none lists only")
    parser.add_argument("--apply", action="store_true",
                        help="write the repairs (default: a dry run that writes nothing)")
    args = parser.parse_args(argv)
    if args.apply and not args.txn_id:
        print("refused: --apply needs at least one --txn-id")
        return 2

    bootstrap = _bootstrap_module()
    try:
        bootstrap.hermetic()
        url = bootstrap.validate_url(os.environ.get("DATABASE_URL"), args.expect_host,
                                     args.expect_db, os.environ)
    except bootstrap.BootstrapError as exc:
        print(f"refused: {exc}")
        return 2
    except Exception as exc:  # e.g. a filesystem error: its message may carry a path
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2
    print(bootstrap.target_line(url))
    print("mode: APPLY" if args.apply else "mode: dry run (nothing is written; --apply writes)")

    # Only now: the rest of the app (settings read the environment, never a .env).
    try:
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.core.database import make_engine
        from app.services import statement_posting_repair
    except Exception as exc:
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    engine = make_engine(url)
    try:
        with Session(engine) as db:
            if db.execute(text("SELECT current_database()")).scalar() != args.expect_db:
                print(f"refused: connected database is not --expect-db '{args.expect_db}'")
                return 2
            lines = statement_posting_repair.run(db, args.txn_id, apply=args.apply)
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"error: {bootstrap.error_class(exc)}")
        return 1
    finally:
        engine.dispose()
    for line in lines:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
