#!/usr/bin/env python3
"""Reconcile a card statement from a JSON file (STU-752).

    DATABASE_URL=... python backend/scripts/reconcile_statement.py \\
        --card-id N --file statement.json --actor-user-id N \\
        --expect-host HOST --expect-db NAME            (dry run: writes nothing)
    ... --apply                                         (a dry run, then the apply)

The URL is read from the environment only. Before any app module is imported the
process moves into an empty temporary directory, so no ``.env`` is ever read, and
``DATABASE_URL`` must name exactly ``--expect-host`` and ``--expect-db`` (the
cutover check's rules, ``app/cutover_check/bootstrap.py``). The file is read and
checked against the statement schema before anything connects.

It calls the service behind ``POST /cards/{account_id}/statements/reconcile`` as
``--actor-user-id``: that user must be an owner or admin of the card, and is the
``created_by_actor`` of what the apply writes. With ``--apply`` the dry run's
fingerprint is used for the apply in the same run. The output lists ids, line
numbers, dates, action kinds, field names, warnings and refusal reasons, never an
amount. Exit codes: 0 done (a dry run: the apply would go ahead), 3 refused
(nothing written), 1 an error, 2 refused before connecting. See
docs/statement-reconcile.md and ``app/services/statement_reconcile_runner.py``.
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
    parser = argparse.ArgumentParser(description="Reconcile a card statement from a JSON file")
    parser.add_argument("--card-id", required=True, type=int)
    parser.add_argument("--file", required=True, help="the statement, as JSON")
    parser.add_argument("--actor-user-id", required=True, type=int,
                        help="the owner or admin of the card the reconcile acts as")
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    parser.add_argument("--apply", action="store_true",
                        help="write the changes (default: a dry run that writes nothing)")
    args = parser.parse_args(argv)
    path = os.path.realpath(args.file)  # before the process moves directory

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
        from pydantic import ValidationError
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.core.database import make_engine
        from app.schemas.statement_reconcile import BankStatement
        from app.services import statement_reconcile_runner as runner
        from app.services.fx import FxRates
    except Exception as exc:
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    try:
        with open(path, "rb") as handle:
            statement = BankStatement.model_validate_json(handle.read())
    except ValidationError as exc:  # its errors echo the input, amounts included
        print("refused: the file is not a valid statement")
        for error in exc.errors():
            where = ".".join(str(part) for part in error["loc"]) or "statement"
            print(f"  {where}: {error['type']}"
                  + (f" ({runner.scrub(error['msg'])})" if error["type"] == "value_error" else ""))
        return 2
    except OSError as exc:
        print(f"refused: the file could not be read ({type(exc).__name__})")
        return 2

    engine = make_engine(url)
    try:
        with Session(engine) as db:
            if db.execute(text("SELECT current_database()")).scalar() != args.expect_db:
                print(f"refused: connected database is not --expect-db '{args.expect_db}'")
                return 2
            outcome = runner.run(db, actor_user_id=args.actor_user_id, card_id=args.card_id,
                                 statement=statement, apply=args.apply, fx=FxRates.offline(db))
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"error: {bootstrap.error_class(exc)}")
        return 1
    finally:
        engine.dispose()
    for line in outcome.lines:
        print(line)
    return outcome.code


if __name__ == "__main__":
    sys.exit(main())
