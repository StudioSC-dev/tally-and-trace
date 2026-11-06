#!/usr/bin/env python3
"""Turn autopay on for named entries and loans (settlement PR 9).

    DATABASE_URL=... python backend/scripts/set_settlement.py \\
        --expect-host HOST --expect-db NAME --entry ID [--entry ID ...] [--loan ID ...]
                                                        (dry run: no rows or balances change; id numbers may skip)
    ... --apply                                         (writes)

Nothing is selected implicitly: at least one ``--entry`` or ``--loan`` is
required. The URL is read from the environment only; before any app module is
imported the process moves into an empty temporary directory, so no ``.env`` is
ever read, and ``DATABASE_URL`` must name exactly ``--expect-host`` and
``--expect-db`` (the cutover check's rules, ``app/cutover_check/bootstrap.py``).
The output lists ids, dates and reason codes, never an amount. Exit codes: 0
done (refused records are listed and left unchanged), 1 an error, 2 refused
before connecting. See docs/settlement-opt-in.md and
``app/services/settlement_opt_in.py``.
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


def _unique(ids):
    return list(dict.fromkeys(ids or []))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Turn autopay on for named entries and loans")
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    parser.add_argument("--entry", type=int, action="append", metavar="ID",
                        help="a budget entry id (repeatable)")
    parser.add_argument("--loan", type=int, action="append", metavar="ID",
                        help="a loan account id (repeatable)")
    parser.add_argument("--apply", action="store_true",
                        help="write the changes (default: a dry run; no rows or balances change, id numbers may skip)")
    args = parser.parse_args(argv)
    entries, loans = _unique(args.entry), _unique(args.loan)
    if not entries and not loans:
        parser.error("name at least one --entry or --loan")

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
    print("mode: APPLY" if args.apply else "mode: dry run (no rows or balances change; id numbers may skip; --apply writes)")

    # Only now: the rest of the app (settings read the environment, never a .env).
    try:
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.core.database import make_engine
        from app.services import settlement_opt_in
    except Exception as exc:
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    engine = make_engine(url)
    try:
        with Session(engine) as db:
            if db.execute(text("SELECT current_database()")).scalar() != args.expect_db:
                print(f"refused: connected database is not --expect-db '{args.expect_db}'")
                return 2
            db.rollback()
            results = settlement_opt_in.run(db, entry_ids=entries, loan_ids=loans,
                                            apply=args.apply)
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"error: {bootstrap.error_class(exc)}")
        return 1
    finally:
        engine.dispose()
    for line in settlement_opt_in.summary(results, args.apply):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
