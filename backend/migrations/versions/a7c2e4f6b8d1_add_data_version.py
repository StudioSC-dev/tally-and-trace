"""add data_version and its statement-level triggers

The database's data version (STU-602, PERF-7; app/core/data_version.py): one row
bumped once per writing transaction, at commit, by a statement-level trigger on
every table except ``data_version.EXCLUDED_TABLES``. Conditional GETs key their
ETag on it.

The tables are listed at migration time (``covered_tables``): every existing table
not excluded gets ``data_version_bump``. An excluded table that does not exist yet
(``card_statements``, ``card_statement_state`` before PERF-6) is skipped. A later
migration that creates a table calls ``data_version.add_bump_trigger``.

Locks: ``CREATE TRIGGER`` takes a SHARE ROW EXCLUSIVE lock on each table, held to
the end of this migration's transaction. Reads go on; writes from the instance still
serving during Render's build wait for the migration (well under a second). A
``lock_timeout`` makes the build fail instead of hanging behind a long transaction.

The downgrade drops the triggers, both functions and both tables.

Revision ID: a7c2e4f6b8d1
Revises: c3d5e7a9b1f4
Create Date: 2026-11-13

"""
from alembic import op
from sqlalchemy import text

from app.core import data_version

revision = "a7c2e4f6b8d1"
down_revision = "c3d5e7a9b1f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("SET LOCAL lock_timeout = '10s'"))
    bind.execute(text(
        "CREATE TABLE data_version ("
        " id smallint PRIMARY KEY CHECK (id = 1),"
        " version bigint NOT NULL)"))
    bind.execute(text("INSERT INTO data_version (id, version) VALUES (1, 1)"))
    # One row per writing transaction, deleted again at its commit.
    bind.execute(text("CREATE TABLE data_version_pending (id bigserial PRIMARY KEY)"))
    bind.execute(text("""
        CREATE FUNCTION data_version_mark() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF current_setting('tt.data_version_marked', true) IS DISTINCT FROM 'on' THEN
                PERFORM set_config('tt.data_version_marked', 'on', true);
                INSERT INTO data_version_pending DEFAULT VALUES;
            END IF;
            RETURN NULL;
        END
        $$"""))
    bind.execute(text("""
        CREATE FUNCTION data_version_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            UPDATE data_version SET version = version + 1 WHERE id = 1;
            DELETE FROM data_version_pending WHERE id = NEW.id;
            RETURN NULL;
        END
        $$"""))
    bind.execute(text(
        "CREATE CONSTRAINT TRIGGER data_version_commit AFTER INSERT ON data_version_pending "
        "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION data_version_commit()"))
    for table in data_version.covered_tables(bind):
        data_version.add_bump_trigger(bind, table)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("SET LOCAL lock_timeout = '10s'"))
    for table in data_version.schema_tables(bind):
        data_version.drop_bump_trigger(bind, table)
    bind.execute(text("DROP TABLE data_version_pending"))
    bind.execute(text("DROP FUNCTION data_version_commit()"))
    bind.execute(text("DROP FUNCTION data_version_mark()"))
    bind.execute(text("DROP TABLE data_version"))
