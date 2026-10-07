"""/health probes the database. Never touches a real database: SessionLocal is replaced."""
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
