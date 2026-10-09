"""Migration 7b3d9f1a5c82 (drop entity schema, STU-230).

STU-229 removed every use of entities from the app; this migration drops what
was left in the database: the six ``entity_id`` columns (with their foreign
keys and the five indexes), ``entity_memberships``, ``entities`` and the enum
types ``entitytype`` and ``memberrole``. ``wishlist_items`` and
``wishlistpriority`` stay. The downgrade restores the schema, not the data.

Runs alembic in a subprocess on a throwaway database (on the same server as
``DATABASE_URL``) seeded with entity rows at e5b7c9d1f3a6. Skips without a
database; the head check needs none.
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[2]
CLEANUP = "e5b7c9d1f3a6"
DROP_ENTITIES = "7b3d9f1a5c82"

INDEXED_TABLES = ("accounts", "transactions", "categories", "allocations", "budget_entries")
ENTITY_TABLES = INDEXED_TABLES + ("wishlist_items",)


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


needs_db = pytest.mark.skipif(not _db_reachable(), reason="no database available")


def test_drop_entities_follows_the_cleanup_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert DROP_ENTITIES in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(DROP_ENTITIES).down_revision == CLEANUP


@pytest.fixture
def scratch_url():
    """A brand-new empty database on the test server, dropped afterwards."""
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_entities_{os.urandom(3).hex()}"
    admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name)
    try:
        yield url
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def _alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr


def _entity_columns(c):
    return {r[0] for r in c.execute(text(
        "SELECT table_name FROM information_schema.columns "
        "WHERE table_schema = 'public' AND column_name = 'entity_id'"))}


def _tables(c):
    return {r[0] for r in c.execute(text(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))}


def _types(c):
    return {r[0] for r in c.execute(text(
        "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace "
        "WHERE n.nspname = 'public' AND t.typtype = 'e'"))}


def _indexes(c):
    return {r[0] for r in c.execute(text(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
        "AND (indexname LIKE '%entity_id' OR indexname LIKE 'ix_entit%')"))}


def _foreign_keys(c):
    """(table, constraint, definition) for every foreign key that points at entities."""
    return {tuple(r) for r in c.execute(text(
        "SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) "
        "FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text = 'entities'"))}


def _assert_entity_schema_present(c):
    assert _entity_columns(c) == set(ENTITY_TABLES) | {"entity_memberships"}
    assert {"entities", "entity_memberships", "wishlist_items"} <= _tables(c)
    assert {"entitytype", "memberrole", "wishlistpriority"} <= _types(c)
    assert _indexes(c) == {f"ix_{t}_entity_id" for t in INDEXED_TABLES} | {
        "ix_entities_id", "ix_entities_name", "ix_entity_memberships_id"}
    assert _foreign_keys(c) == {
        *((t, f"fk_{t}_entity_id", "FOREIGN KEY (entity_id) REFERENCES entities(id)")
          for t in INDEXED_TABLES),
        ("wishlist_items", "wishlist_items_entity_id_fkey",
         "FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL"),
        ("entity_memberships", "entity_memberships_entity_id_fkey",
         "FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE"),
    }
    nullable = {r[0]: r[1] for r in c.execute(text(
        "SELECT table_name, is_nullable FROM information_schema.columns "
        "WHERE table_schema = 'public' AND column_name = 'entity_id'"))}
    assert {t: nullable[t] for t in ENTITY_TABLES} == {t: "YES" for t in ENTITY_TABLES}
    assert nullable["entity_memberships"] == "NO"


def _assert_entity_schema_gone(c):
    assert _entity_columns(c) == set()
    assert not {"entities", "entity_memberships"} & _tables(c)
    assert not {"entitytype", "memberrole"} & _types(c)
    assert _indexes(c) == set()
    # The tables and the enum that stay.
    assert "wishlist_items" in _tables(c)
    assert "wishlistpriority" in _types(c)


def _seed_entities(c):
    """A user with an entity, a membership and a non-null entity_id on every table."""
    user = c.execute(text(
        "INSERT INTO users (email, password_hash, first_name, last_name) "
        "VALUES ('ent@example.com', 'x', 'Ent', 'Ity') RETURNING id")).scalar_one()
    entity = c.execute(text("INSERT INTO entities (name) VALUES ('E') RETURNING id")).scalar_one()
    c.execute(text("INSERT INTO entity_memberships (user_id, entity_id, role) "
                   "VALUES (:u, :e, 'owner')"), {"u": user, "e": entity})
    account = c.execute(text(
        "INSERT INTO accounts (user_id, name, account_type, balance, currency, entity_id) "
        "VALUES (:u, 'A', 'checking', 0, 'PHP', :e) RETURNING id"),
        {"u": user, "e": entity}).scalar_one()
    c.execute(text("INSERT INTO categories (user_id, name, entity_id) VALUES (:u, 'C', :e)"),
              {"u": user, "e": entity})
    c.execute(text(
        "INSERT INTO transactions (user_id, account_id, transaction_type, amount, "
        "transfer_fee, transaction_date, entity_id) "
        "VALUES (:u, :a, 'debit', 5, 0, now(), :e)"), {"u": user, "a": account, "e": entity})
    c.execute(text(
        "INSERT INTO allocations (user_id, account_id, name, allocation_type, entity_id) "
        "VALUES (:u, :a, 'F', 'budget', :e)"), {"u": user, "a": account, "e": entity})
    c.execute(text(
        "INSERT INTO budget_entries (user_id, account_id, name, entry_type, amount, currency, "
        "next_occurrence, end_mode, entity_id) "
        "VALUES (:u, :a, 'B', 'expense', 1, 'PHP', now(), 'indefinite', :e)"),
        {"u": user, "a": account, "e": entity})
    c.execute(text("INSERT INTO wishlist_items (user_id, name, estimated_cost, entity_id) "
                   "VALUES (:u, 'W', 1, :e)"), {"u": user, "e": entity})
    return user


@needs_db
def test_the_entity_schema_is_dropped_and_restored_and_the_rest_is_kept(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", CLEANUP)
        with engine.begin() as c:
            _assert_entity_schema_present(c)
            user = _seed_entities(c)

        _alembic(scratch_url, "upgrade", DROP_ENTITIES)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == DROP_ENTITIES
            _assert_entity_schema_gone(c)
            # Everything but the entity data survives.
            for table in ("accounts", "categories", "transactions", "allocations",
                          "budget_entries", "wishlist_items"):
                assert c.execute(text(f"SELECT count(*) FROM {table} WHERE user_id = :u"),
                                 {"u": user}).scalar_one() == 1

        _alembic(scratch_url, "downgrade", CLEANUP)
        with engine.connect() as c:
            assert c.execute(text("SELECT version_num FROM alembic_version")).scalar_one() \
                == CLEANUP
            _assert_entity_schema_present(c)
            # Schema only: the columns are back and empty, the tables are empty.
            for table in ENTITY_TABLES:
                assert c.execute(text(
                    f"SELECT count(entity_id) FROM {table}")).scalar_one() == 0
            assert c.execute(text("SELECT count(*) FROM entities")).scalar_one() == 0
            assert c.execute(text("SELECT count(*) FROM entity_memberships")).scalar_one() == 0

        _alembic(scratch_url, "upgrade", DROP_ENTITIES)
        with engine.connect() as c:
            _assert_entity_schema_gone(c)
    finally:
        engine.dispose()
