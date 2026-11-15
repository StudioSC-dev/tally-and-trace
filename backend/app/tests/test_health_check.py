"""/health probes the database. Never touches a real database: SessionLocal is replaced."""
import logging

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.main as main_module


@pytest.fixture()
def client():
    # No `with`: skips the lifespan, which would seed the database.
    return TestClient(main_module.app)


@pytest.fixture()
def reachable_db(monkeypatch):
    engine = create_engine("sqlite://")
    monkeypatch.setattr(main_module, "SessionLocal", sessionmaker(bind=engine))


@pytest.fixture()
def unreachable_db(monkeypatch):
    def broken_session():
        raise RuntimeError("connection refused")

    monkeypatch.setattr(main_module, "SessionLocal", broken_session)


def test_health_ok_when_database_reachable(client, reachable_db):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy", "database": "ok"}


def test_health_503_when_session_cannot_open(client, unreachable_db):
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "database": "unavailable"}


def test_health_503_when_query_fails(client, monkeypatch):
    class FailingSession:
        closed = False

        def execute(self, *_args, **_kwargs):
            raise RuntimeError("server closed the connection")

        def close(self):
            FailingSession.closed = True

    monkeypatch.setattr(main_module, "SessionLocal", FailingSession)
    r = client.get("/health")
    assert r.status_code == 503
    assert FailingSession.closed


def test_health_head_ok(client, reachable_db):
    r = client.head("/health")
    assert r.status_code == 200
    assert r.content == b""


def test_health_head_503_when_database_down(client, unreachable_db):
    assert client.head("/health").status_code == 503


def test_probe_failure_returns_503(client, unreachable_db):
    r = client.get("/health")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "database": "unavailable"}


def test_probe_failure_is_not_error_level(client, unreachable_db, caplog):
    with caplog.at_level(logging.DEBUG):
        client.get("/health")
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


def test_probe_failure_keeps_traceback(client, unreachable_db, caplog):
    with caplog.at_level(logging.DEBUG):
        client.get("/health")
    records = [
        r for r in caplog.records if r.getMessage() == "Health check database probe failed"
    ]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert records[0].exc_info is not None
    assert records[0].exc_info[0] is RuntimeError


def test_successful_probe_response_unchanged(client, reachable_db, caplog):
    with caplog.at_level(logging.DEBUG):
        r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "healthy", "database": "ok"}
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
