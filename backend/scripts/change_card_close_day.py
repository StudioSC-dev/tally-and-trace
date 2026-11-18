#!/usr/bin/env python3
"""Change one card's statement closing day, all or nothing (STU-744).

    DATABASE_URL=... python backend/scripts/change_card_close_day.py \\
        --card-id N --close-day D --expect-host HOST --expect-db NAME
                                                        (dry run: writes nothing)
    ... --accept-history-shift                          (past statements may change)
    ... --apply                                         (writes)

The URL is read from the environment only. Before any app module is imported
the process moves into an empty temporary directory, so no ``.env`` is ever
read, and ``DATABASE_URL`` must name exactly ``--expect-host`` and
``--expect-db`` (the cutover check's rules, ``app/cutover_check/bootstrap.py``).
Without ``--apply`` every change is made and checked inside the transaction,
then rolled back. The output lists ids, dates and refusal reasons, never an
amount. Exit codes: 0 changed (or, in a dry run, would change), 3 refused
(nothing written; the reasons are listed), 1 an error (nothing written), 2
refused before connecting. See docs/close-day-change.md and
``app/services/close_day_change.py``.
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
    parser = argparse.ArgumentParser(description="Change one card's statement closing day")
    parser.add_argument("--card-id", type=int, required=True)
    parser.add_argument("--close-day", type=int, required=True)
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    parser.add_argument("--accept-history-shift", action="store_true",
                        help="go ahead when a past statement's rows would change")
    parser.add_argument("--apply", action="store_true",
                        help="write the change (default: a dry run that writes nothing)")
    args = parser.parse_args(argv)

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
        from app.services import close_day_change
    except Exception as exc:
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    engine = make_engine(url)
    try:
        with Session(engine) as db:
            if db.execute(text("SELECT current_database()")).scalar() != args.expect_db:
                print(f"refused: connected database is not --expect-db '{args.expect_db}'")
                return 2
            result = close_day_change.run(
                db, args.card_id, args.close_day, apply=args.apply,
                accept_history_shift=args.accept_history_shift)
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"error: {bootstrap.error_class(exc)}")
        return 1
    finally:
        engine.dispose()
    for line in result.lines():
        print(line)
    return 0 if result.status == "changed" else 3


if __name__ == "__main__":
    sys.exit(main())
