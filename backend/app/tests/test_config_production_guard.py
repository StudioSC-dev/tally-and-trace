"""Tests for the production placeholder-config guard (pure, no database).

Hermeticity matters more than usual here, from two directions:

* ``_env_file=None`` -- a developer's local ``backend/.env`` would otherwise supply
  real values and mask the guard entirely.
* ``clean_env`` -- CI *exports* DATABASE_URL and SECRET_KEY, which would likewise
  mean the placeholder never appears and every assertion below passes vacuously.

Both together mirror the Render container: no ``.env`` file, and only the env vars
the test itself sets.
"""
import pytest

from app.core.config import (
    _PLACEHOLDER_DATABASE_URL,
    _PLACEHOLDER_SECRET_KEY,
    Settings,
)

REAL_DB = "postgresql://real:real@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres"
REAL_KEY = "a-real-generated-secret-key"


@pytest.fixture
def clean_env(monkeypatch):
    """Strip the ambient config so the field defaults (the placeholders) apply."""
    for var in ("ENVIRONMENT", "DATABASE_URL", "SECRET_KEY"):
        monkeypatch.delenv(var, raising=False)


def _build(**overrides):
    return Settings(_env_file=None, **overrides)


def test_fixture_actually_exposes_the_placeholders(clean_env):
    """Guards the guard: if this fails, every other test here is vacuous."""
    settings = _build()
    assert settings.DATABASE_URL == _PLACEHOLDER_DATABASE_URL
    assert settings.SECRET_KEY == _PLACEHOLDER_SECRET_KEY


@pytest.mark.parametrize("environment", ["development", "test", "staging"])
def test_placeholders_allowed_outside_production(clean_env, environment):
    settings = _build(ENVIRONMENT=environment)
    assert settings.DATABASE_URL == _PLACEHOLDER_DATABASE_URL
    assert settings.SECRET_KEY == _PLACEHOLDER_SECRET_KEY


def test_production_with_real_values_boots(clean_env):
    settings = _build(ENVIRONMENT="production", DATABASE_URL=REAL_DB, SECRET_KEY=REAL_KEY)
    assert settings.DATABASE_URL == REAL_DB


def test_production_rejects_placeholder_database_url(clean_env):
    with pytest.raises(ValueError, match="DATABASE_URL"):
        _build(ENVIRONMENT="production", SECRET_KEY=REAL_KEY)


def test_production_rejects_placeholder_secret_key(clean_env):
    with pytest.raises(ValueError, match="SECRET_KEY"):
        _build(ENVIRONMENT="production", DATABASE_URL=REAL_DB)


def test_production_reports_every_missing_value_at_once(clean_env):
    """Both names in one message -- don't make a deployer fix these one redeploy at a time."""
    with pytest.raises(ValueError) as exc:
        _build(ENVIRONMENT="production")
    assert "DATABASE_URL" in str(exc.value)
    assert "SECRET_KEY" in str(exc.value)


@pytest.mark.parametrize("environment", ["PRODUCTION", "Production", " production "])
def test_production_detection_is_case_and_whitespace_insensitive(clean_env, environment):
    with pytest.raises(ValueError):
        _build(ENVIRONMENT=environment)
