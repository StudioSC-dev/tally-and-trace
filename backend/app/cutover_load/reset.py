"""Undo a cutover load, or sign it off (plan v3, sections 2.2 step 10 and 2.3).

**Reset** deletes everything the owner owns except the user and the
Household tag, in one transaction, and only inside the maintenance window:
the run record is ``complete`` and not signed off, the target and owner
match the record, the owner has not logged in since the load started, the
owner's row counts equal the record's, the fingerprint of the owner's state
(``loader.owner_fingerprint``) equals the one taken inside the load, and no
other user's row references an owner account, category or entry.

The fingerprint is the content check: it catches an edit that moves no
timestamp and no count (a tag rename, a swapped tag link). Timestamps after
``finished_at`` are reported but do not refuse: with the content unchanged a
later ``updated_at`` is a no-op save or the application's clock (``utc_now``)
running ahead of the database's, and refusing on it would block a safe reset. Afterwards the
pre-load guard passes again and every other user's row counts are unchanged.

**Sign-off** makes no database connection: it writes ``signed_off_at`` into
a ``complete`` run record once the cutover check's report (``report``
"cutover-check", ``version`` 1) records an overall pass for the same owner
id, database, server address and session time zone, with ``checked_at`` at or
after the record's ``finished_at``. Reset then refuses.

The database imports are made inside ``run_reset``, so a sign-off imports no
database code.
"""

from datetime import datetime, timezone
from typing import Callable, Dict, Optional

from app.cutover_load.bootstrap import Refused
from app.cutover_load.outputs import read_json, refuse_existing, replace_private, to_json

# The cutover check's report (STU-204) as sign-off reads it.
CHECK_KIND, CHECK_VERSION = "cutover-check", 1
CHECK_OVERALL, CHECK_PASS = "overall", "pass"
CHECK_TARGET_KEYS = ("owner_id", "database", "server_addr", "session_timezone")


def _record(path: str) -> dict:
    record = read_json(path, "run record")
    if record.get("kind") != "cutover-load-run":
        raise Refused("run_record", "this file is not a cutover run record")
    return record


def _window_open(record: dict, confirm: str) -> None:
    if record.get("status") != "complete":
        raise Refused("run_record", "the run record is not complete")
    if record.get("signed_off_at"):
        raise Refused("signed_off", "the cutover was signed off; the window is closed")
    if confirm.strip().lower() != str(record.get("owner_email", "")).strip().lower():
        raise Refused("confirm", "--confirm is not the run record's owner email")


# --- Sign-off ------------------------------------------------------------------------------

def sign_off(*, run_record_path: str, check_report_path: str, confirm: str,
             out: Callable[[str], None] = print) -> int:
    record = _record(run_record_path)
    _window_open(record, confirm)
    report = read_json(check_report_path, "check report")
    if report.get("report") != CHECK_KIND or report.get("version") != CHECK_VERSION:
        raise Refused("check_report", "this file is not a version 1 cutover check report")
    if report.get(CHECK_OVERALL) != CHECK_PASS:
        raise Refused("check_report", "the cutover check did not record an overall pass")
    for key in CHECK_TARGET_KEYS:
        if record.get(key) is None or report.get(key) != record.get(key):
            raise Refused("check_report", f"the check report's {key} is not the run record's")
    try:  # the check must have read the loaded state, not an earlier one
        checked = datetime.fromisoformat(report["checked_at"])
        finished = datetime.fromisoformat(record["finished_at"])
        early = checked < finished
    except (KeyError, TypeError, ValueError):
        raise Refused("check_report", "the check report or run record has no valid "
                                      "checked_at or finished_at") from None
    if early:
        raise Refused("check_report", "the check ran before the load finished")
    signed = {**record, "signed_off_at": datetime.now(timezone.utc).isoformat()}
    replace_private(run_record_path, to_json(signed))
    out("sign-off: pass; the maintenance window is closed and reset now refuses")
    return 0


# --- Reset ---------------------------------------------------------------------------------

TIMESTAMPED = ("accounts", "transactions", "budget_entries", "categories", "allocations",
               "wishlist_items")


def _later_rows(db, owner_id: int, finished_at) -> Dict[str, int]:
    """Owner rows with a timestamp after ``finished_at``, per table."""
    from sqlalchemy import text

    params = {"owner": owner_id, "after": finished_at}
    later = {}
    for table in TIMESTAMPED:
        later[table] = db.execute(text(
            f"SELECT count(*) FROM {table} WHERE user_id = :owner "
            "AND (created_at > :after OR updated_at > :after)"), params).scalar()
    later["tags"] = db.execute(text(
        "SELECT count(*) FROM tags WHERE user_id = :owner AND created_at > :after"),
        params).scalar()
    later["account_shares"] = db.execute(text(
        "SELECT count(*) FROM account_shares WHERE created_at > :after AND (user_id = :owner "
        "OR account_id IN (SELECT id FROM accounts WHERE user_id = :owner))"), params).scalar()
    later["tag_shares"] = db.execute(text(
        "SELECT count(*) FROM tag_shares WHERE created_at > :after AND (user_id = :owner "
        "OR tag_id IN (SELECT id FROM tags WHERE user_id = :owner))"), params).scalar()
    return {table: n for table, n in later.items() if n}


FOREIGN_REFERENCES = {
    "transactions": ("account_id IN ({a}) OR transfer_from_account_id IN ({a}) "
                     "OR transfer_to_account_id IN ({a}) OR category_id IN ({c}) "
                     "OR budget_entry_id IN ({e})"),
    "budget_entries": ("account_id IN ({a}) OR overflow_account_id IN ({a}) "
                       "OR transfer_to_account_id IN ({a}) OR category_id IN ({c})"),
    "allocations": "account_id IN ({a})",
}


def _foreign_references(db, owner_id: int) -> Dict[str, int]:
    from sqlalchemy import text

    owned = {"a": "SELECT id FROM accounts WHERE user_id = :owner",
             "c": "SELECT id FROM categories WHERE user_id = :owner",
             "e": "SELECT id FROM budget_entries WHERE user_id = :owner"}
    found = {}
    for table, criterion in FOREIGN_REFERENCES.items():
        n = db.execute(text(f"SELECT count(*) FROM {table} WHERE user_id <> :owner AND "
                            f"({criterion.format(**owned)})"), {"owner": owner_id}).scalar()
        if n:
            found[table] = n
    return found


def other_counts(db, owner_id: int) -> Dict[str, int]:
    """Every other user's row counts, leaving out shares on the owner's objects."""
    from sqlalchemy import text

    params = {"owner": owner_id}
    counts = {"users": db.execute(text("SELECT count(*) FROM users WHERE id <> :owner"),
                                  params).scalar()}
    for table in (*TIMESTAMPED, "tags"):
        counts[table] = db.execute(text(f"SELECT count(*) FROM {table} WHERE user_id <> :owner"),
                                   params).scalar()
    for link, column, table in (("account_tags", "account_id", "accounts"),
                                ("transaction_tags", "transaction_id", "transactions"),
                                ("budget_entry_tags", "budget_entry_id", "budget_entries")):
        counts[link] = db.execute(text(
            f"SELECT count(*) FROM {link} WHERE {column} NOT IN "
            f"(SELECT id FROM {table} WHERE user_id = :owner) "
            "AND tag_id NOT IN (SELECT id FROM tags WHERE user_id = :owner)"), params).scalar()
    counts["account_shares"] = db.execute(text(
        "SELECT count(*) FROM account_shares WHERE user_id <> :owner AND account_id NOT IN "
        "(SELECT id FROM accounts WHERE user_id = :owner)"), params).scalar()
    counts["tag_shares"] = db.execute(text(
        "SELECT count(*) FROM tag_shares WHERE user_id <> :owner AND tag_id NOT IN "
        "(SELECT id FROM tags WHERE user_id = :owner)"), params).scalar()
    return counts


def delete_owner_rows(db, owner_id: int, household_id: int) -> None:
    """Section 2.3's deletes, in its order; keeps the user and the Household tag."""
    from sqlalchemy import text

    p = {"owner": owner_id, "household": household_id}
    statements = (
        "DELETE FROM transaction_tags WHERE transaction_id IN "
        "(SELECT id FROM transactions WHERE user_id = :owner)",
        "DELETE FROM budget_entry_tags WHERE budget_entry_id IN "
        "(SELECT id FROM budget_entries WHERE user_id = :owner)",
        "DELETE FROM account_tags WHERE account_id IN "
        "(SELECT id FROM accounts WHERE user_id = :owner)",
        "DELETE FROM tag_shares WHERE tag_id = :household",
        "DELETE FROM account_shares WHERE account_id IN "
        "(SELECT id FROM accounts WHERE user_id = :owner)",
        "DELETE FROM transactions WHERE user_id = :owner",
        "DELETE FROM budget_entries WHERE user_id = :owner",
        "DELETE FROM allocations WHERE user_id = :owner",
        "DELETE FROM wishlist_items WHERE user_id = :owner",
        "DELETE FROM categories WHERE user_id = :owner",
        "UPDATE accounts SET payment_account_id = NULL, payment_overflow_account_id = NULL "
        "WHERE user_id = :owner",
        "DELETE FROM accounts WHERE user_id = :owner",
        "DELETE FROM tags WHERE user_id = :owner AND NOT is_system",
    )
    for statement in statements:
        db.execute(text(statement), p)


def run_reset(*, url, run_record_path: str, confirm: str, dry_run: bool, expect_db: str,
              expect_server_addr: Optional[str], report_path: Optional[str] = None,
              out: Callable[[str], None] = print) -> int:
    """Reset the owner (section 2.3); 0 on success. Raises ``Refused`` or
    ``CutoverError`` on any refusal, with nothing changed. ``report_path``, when
    given, is where the wrapper writes a refusal's details (tables and counts,
    never figures); it must not exist yet."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import NullPool

    from app.cutover_load.bootstrap import check_target, observe_target
    from app.cutover_load.loader import (
        CutoverError, check_guard, find_owner, household_tag, owner_counts, owner_fingerprint,
        take_lock,
    )
    from app.models.user import User

    refuse_existing(report_path)
    record = _record(run_record_path)
    _window_open(record, confirm)
    if not record.get("fingerprint"):
        raise Refused("run_record", "the run record has no fingerprint of the loaded state")
    # REPEATABLE READ: one snapshot for the whole reset, so the deletes act on
    # exactly the state whose counts and fingerprint were just checked.
    engine = create_engine(url, poolclass=NullPool, isolation_level="REPEATABLE READ")
    try:
        with engine.connect() as conn:
            trans = conn.begin()
            try:
                observed = observe_target(conn)
                out(f"observed: db={observed[0]} server_addr={observed[1]}")
                database, address = check_target(observed, expect_db=expect_db,
                                                 expect_server_addr=expect_server_addr)
                if (database, address) != (record.get("database"), record.get("server_addr")):
                    raise Refused("target", "the database or server address is not the "
                                            "run record's")
                take_lock(conn)
                db = Session(bind=conn, join_transaction_mode="create_savepoint",
                             autoflush=False)
                owner = find_owner(db, confirm)
                if owner.id != record.get("owner_id"):
                    raise CutoverError("owner", "--confirm", "this owner is not the run record's")
                started = datetime.fromisoformat(record["started_at"])
                finished = datetime.fromisoformat(record["finished_at"])
                user = db.get(User, owner.id)
                if user.last_login is not None and user.last_login > started:
                    raise CutoverError("last_login", "owner",
                                       "the owner logged in after the load started")
                counts = owner_counts(db, owner.id)
                if counts != record.get("row_counts"):
                    differ = sorted(t for t in set(counts) | set(record.get("row_counts", {}))
                                    if counts.get(t) != record["row_counts"].get(t))
                    raise CutoverError("row_counts", "owner",
                                       f"the owner's row counts differ in: {', '.join(differ)}")
                fingerprint = owner_fingerprint(db, owner.id)
                if fingerprint["sha256"] != record["fingerprint"]:
                    stored = record.get("fingerprint_tables", {})
                    changed = sorted(t for t, h in fingerprint["tables"].items()
                                     if stored.get(t) != h)
                    raise CutoverError("changed_after_load", "owner",
                                       "the owner's rows changed after the load in: "
                                       f"{', '.join(changed) or 'unknown tables'}")
                later = _later_rows(db, owner.id, finished)
                if later:  # content unchanged (the fingerprint matched): report only
                    out(f"note: later timestamps with unchanged content: {later}")
                foreign = _foreign_references(db, owner.id)
                if foreign:
                    raise CutoverError("foreign_references", "owner",
                                       f"other users' rows reference the owner's: {foreign}")
                household_id = household_tag(db, owner)
                before = other_counts(db, owner.id)
                delete_owner_rows(db, owner.id, household_id)
                db.flush()
                check_guard(db, owner, household_id)
                after = other_counts(db, owner.id)
                if after != before:
                    raise CutoverError("other_users", "-", "another user's row counts changed")
                db.commit()  # releases the savepoint; the outer transaction decides
                db.close()
                if dry_run:
                    trans.rollback()
                    out("reset dry run: pass; rolled back")
                else:
                    trans.commit()
                    out("reset: committed; the owner is back to the pre-load state")
                out("owner rows before the reset (the Household tag is kept):")
                for table, count in sorted(counts.items()):
                    out(f"  {table}: {count}")
                return 0
            except BaseException:
                if trans.is_active:
                    trans.rollback()
                raise
    finally:
        engine.dispose()
