"""Check, or fill, the stored closed card statements (STU-601; docs/statements-store.md).

    DATABASE_URL=... python -m app.scripts.statements_store \\
        --expect-host HOST --expect-db NAME --dry-run [--card ID]
    ... --apply [--card ID]

``--dry-run`` writes nothing: it runs in a READ ONLY transaction (no catch-up, no
lock) and prints, per credit card, whether the stored rows match the rows and
whether the summaries read from the store equal the full replay. ``--apply``
recomputes each card's stored statements under its lock (the same materialiser as
the write-through and the catch-up), one card per transaction, then prints the
same check. Running it twice changes nothing more: it is idempotent. Neither is
needed for correctness (reads catch up by themselves); ``--dry-run`` is the check
on real data.

The URL is read from the environment only and must name exactly ``--expect-host``
and ``--expect-db`` (``app/cutover_check/bootstrap.py``'s rules); the process moves
into an empty directory first, so no ``.env`` is read. Output: card ids, counts and
yes/no only, never an amount or a name. Exit codes: 0 all equal, 3 a difference,
1 an error, 2 refused before connecting.
"""
import argparse
import os
import sys
from typing import List, Optional


def _yes(flag: bool) -> str:
    return "yes" if flag else "no"


def run(db, card_ids: Optional[List[int]], apply: bool) -> List[str]:
    """The report lines; with ``apply`` each card is recomputed (and committed) first.
    The caller set the transaction READ ONLY for a dry run."""
    from sqlalchemy import select

    from app.core.access import viewable_account_ids
    from app.core.time import manila_today
    from app.models.account import Account, AccountType
    from app.models.user import User
    from app.services import statements_store as store

    today = manila_today()
    query = select(Account).where(Account.account_type == AccountType.CREDIT).order_by(Account.id)
    if card_ids:
        query = query.where(Account.id.in_(card_ids))
    cards = [c for c in db.execute(query).scalars() if store._is_card(c)]
    ids = [c.id for c in cards]
    if apply:
        for card_id in ids:
            conn = db.connection()
            store._lock(conn, [card_id])
            card = store._cards(conn, [card_id]).get(card_id)
            store.repopulate(conn, card_id, card, today)
            db.commit()
        cards = [db.get(Account, i) for i in ids]
    lines = [f"day: {today.isoformat()}  cards: {len(cards)}"]
    equal = 0
    for card in cards:
        owner = db.get(User, card.user_id)
        got = store.verify_card(db, card, viewable_account_ids(db, owner), today)
        ok = got["rows_equal"] and got["summaries_equal"]
        equal += ok
        lines.append(
            f"card {got['card_id']}: stored_rows={got['stored_rows']} "
            f"materialized={_yes(got['materialized'])} behind={_yes(got['behind'])} "
            f"rows_equal={_yes(got['rows_equal'])} "
            f"summaries_equal={_yes(got['summaries_equal'])}")
    lines.append(f"all_equal: {_yes(equal == len(cards))} ({equal}/{len(cards)})")
    return lines


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Check or fill the stored card statements")
    parser.add_argument("--expect-host", required=True)
    parser.add_argument("--expect-db", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="check only; writes nothing")
    mode.add_argument("--apply", action="store_true", help="recompute, then check")
    parser.add_argument("--card", type=int, action="append", default=[],
                        help="a card id (repeatable); default every credit card")
    args = parser.parse_args(argv)

    from app.cutover_check import bootstrap

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
    print("mode: APPLY" if args.apply else "mode: dry run (READ ONLY; nothing is written)")
    # Only now: the rest of the app (settings read the environment, never a .env).
    os.environ["TT_DISABLE_DOTENV"] = "1"
    try:
        from sqlalchemy import text
        from sqlalchemy.orm import Session

        from app.core.database import make_engine
    except Exception as exc:
        print(f"refused: {bootstrap.error_class(exc)}")
        return 2

    engine = make_engine(url)
    try:
        with Session(engine) as db:
            if not args.apply:
                db.execute(text("SET TRANSACTION READ ONLY"))
            if db.execute(text("SELECT current_database()")).scalar() != args.expect_db:
                print(f"refused: connected database is not --expect-db '{args.expect_db}'")
                return 2
            lines = run(db, args.card or None, apply=args.apply)
            db.rollback()
    except Exception as exc:  # driver errors may carry the DSN: class name only
        print(f"error: {bootstrap.error_class(exc)}")
        return 1
    finally:
        engine.dispose()
    for line in lines:
        print(line)
    return 0 if lines[-1].startswith("all_equal: yes") else 3


if __name__ == "__main__":
    sys.exit(main())
