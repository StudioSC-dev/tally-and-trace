"""The ``fx_rates`` table, its seed and its database store (STU-236, plan B1/B3).

The migration seeds the ten currencies from the provider's file dated
2026-10-12, every row with the epoch ``fetched_at`` so the first conversion
schedules a refresh and any real fetch wins the upsert. Also: every
``CurrencyType`` has a seed row (plan open question 3), ``DbRateStore``'s
upsert keeps the newer row, and the application's suite never reaches the
provider (the B8 override is in place).
"""
import os
import subprocess
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

from app.models.user import CurrencyType
from app.tests.conftest import sw_db_reachable

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="no database available")

BACKEND_DIR = Path(__file__).resolve().parents[2]
PREVIOUS = "d4b8e2f6a1c3"
FX = "e7a3c5f9b2d4"
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
SOURCE = "seed currency-api 2026-10-12"
SEED = {
    "USD": Decimal("1"), "PHP": Decimal("62.77060786"), "EUR": Decimal("0.89282214"),
    "GBP": Decimal("0.75552913"), "JPY": Decimal("158.3874829"),
    "AUD": Decimal("1.43389336"), "CAD": Decimal("1.42612637"),
    "CHF": Decimal("0.83093222"), "CNY": Decimal("6.69308518"),
    "SGD": Decimal("1.28023669"),
}


def test_fx_rates_follows_received_amount_on_the_single_head():
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    (head,) = script.get_heads()
    assert FX in {rev.revision for rev in script.walk_revisions("base", head)}
    assert script.get_revision(FX).down_revision == PREVIOUS


def test_every_currency_has_a_seed_row():
    assert set(SEED) == {c.value for c in CurrencyType}


@pytest.fixture
def scratch_url():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"{base.database}_fx_{os.urandom(3).hex()}"
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
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND_DIR, env=env,
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_fx_rates_upgrade_seeds_ten_rows_and_downgrades(scratch_url):
    engine = create_engine(scratch_url)
    try:
        _alembic(scratch_url, "upgrade", PREVIOUS)
        with engine.begin() as c:
            assert "fx_rates" not in inspect(c).get_table_names()

        _alembic(scratch_url, "upgrade", FX)
        with engine.begin() as c:
            columns = {col["name"]: col for col in inspect(c).get_columns("fx_rates")}
            assert set(columns) == {"currency", "per_usd", "as_of", "fetched_at", "source"}
            assert (columns["per_usd"]["type"].precision,
                    columns["per_usd"]["type"].scale) == (20, 10)
            assert columns["currency"]["type"].length == 3
            assert columns["source"]["type"].length == 32
            assert inspect(c).get_pk_constraint("fx_rates")["constrained_columns"] == ["currency"]
            rows = c.execute(text(
                "SELECT currency, per_usd, as_of, fetched_at, source FROM fx_rates")).all()
            assert {r.currency: r.per_usd for r in rows} == SEED
            assert {(r.as_of, r.fetched_at, r.source) for r in rows} == {
                (date(2026, 10, 12), EPOCH, SOURCE)}
            assert {r.currency for r in rows} == {c.value for c in CurrencyType}

        _alembic(scratch_url, "downgrade", PREVIOUS)
        with engine.begin() as c:
            assert "fx_rates" not in inspect(c).get_table_names()
            assert c.execute(text(
                "SELECT version_num FROM alembic_version")).scalar_one() == PREVIOUS
    finally:
        engine.dispose()


def test_db_store_reads_the_seed_and_upserts_only_newer_rows(scratch_url):
    from sqlalchemy.orm import sessionmaker

    from app.services.fx import DbRateStore, FxRates, StoredRate

    _alembic(scratch_url, "upgrade", FX)
    engine = create_engine(scratch_url)
    session = sessionmaker(bind=engine)()
    try:
        store = DbRateStore(session)
        php = store.get("PHP")
        assert php == StoredRate("PHP", Decimal("62.7706078600"), date(2026, 10, 12),
                                 datetime(1970, 1, 1), SOURCE)  # naive UTC
        rates = FxRates(store, None, lambda: datetime(2026, 11, 2), lambda: None)
        rate = rates.rate("USD", "PHP")
        assert (rate.rate, rate.stale) == (Decimal("62.770608"), True)

        newer = datetime(2026, 11, 2, 1, 0)
        store.upsert([StoredRate("PHP", Decimal("58"), date(2026, 11, 1), newer,
                                 "currency-api")])
        store.upsert([StoredRate("PHP", Decimal("50"), date(2026, 10, 1),
                                 datetime(2026, 11, 1), "currency-api")])  # older: ignored
        session.commit()
        fresh = DbRateStore(session).get("PHP")
        assert (fresh.per_usd, fresh.fetched_at, fresh.source) == (
            Decimal("58.0000000000"), newer, "currency-api")
        assert DbRateStore(session).get("EUR").fetched_at == datetime(1970, 1, 1)
    finally:
        session.close()
        engine.dispose()


def test_refresh_task_writes_through_its_own_session(scratch_url, monkeypatch):
    """The real store factory: the task opens and commits its own session."""
    from sqlalchemy.orm import sessionmaker

    from app.services import fx

    _alembic(scratch_url, "upgrade", FX)
    engine = create_engine(scratch_url)
    monkeypatch.setattr(fx, "_session_factory", lambda: sessionmaker(bind=engine)())

    class Provider:
        calls = 0

        def fetch(self):
            Provider.calls += 1
            return {c.value: (Decimal("2") if c.value != "USD" else Decimal("1"),
                              date(2026, 11, 1)) for c in CurrencyType}

    now = datetime(2026, 11, 2, 0, 0)
    refresher = fx.Refresher(provider=Provider(), clock=lambda: now,
                             store_factory=fx.db_store_session)
    try:
        refresher.run()
        assert Provider.calls == 1
        with engine.connect() as c:
            rows = c.execute(text("SELECT currency, per_usd, fetched_at FROM fx_rates")).all()
        assert len(rows) == 10
        assert {r.fetched_at for r in rows} == {now.replace(tzinfo=timezone.utc)}
        assert {r.currency: r.per_usd for r in rows}["USD"] == Decimal("1")
        refresher.run()
        assert Provider.calls == 1  # every row now fresh
    finally:
        engine.dispose()


def test_the_suite_never_reaches_the_provider(sw_client):
    from app.main import app
    from app.services import fx
    from app.tests.conftest import FX_REF

    override = app.dependency_overrides[fx.get_fx]()
    assert override.clock() == FX_REF
    with pytest.raises(AssertionError):
        override.provider.fetch()
    with pytest.raises(AssertionError):
        fx._refresher.provider.fetch()
    assert fx._refresher.clock() == FX_REF
    assert FX_REF == datetime(2026, 11, 2, 0, 0)
