"""Tests for the test-database guard and the settings switch it relies on."""
import importlib.util
from pathlib import Path

import app.core.config as config_module

CONFIG_PATH = Path(config_module.__file__)


def _load_config_fresh():
    """Execute core/config.py again under another name, leaving sys.modules alone."""
    spec = importlib.util.spec_from_file_location("_config_probe", CONFIG_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROBE_NAME = "Probe from a temporary .env"


def _probe_dotenv(monkeypatch, tmp_path):
    """Run from ``tmp_path`` holding a synthetic ``.env``, so reloading config
    (``settings = Settings()``) never parses a real one from the cwd."""
    (tmp_path / ".env").write_text(f"PROJECT_NAME={PROBE_NAME}\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("PROJECT_NAME", raising=False)


def test_dotenv_is_skipped_when_tt_disable_dotenv_is_set(monkeypatch, tmp_path):
    _probe_dotenv(monkeypatch, tmp_path)
    monkeypatch.setenv("TT_DISABLE_DOTENV", "1")
    module = _load_config_fresh()
    assert module.Settings.model_config["env_file"] is None
    assert module.settings.PROJECT_NAME != PROBE_NAME


def test_dotenv_is_read_when_tt_disable_dotenv_is_unset_or_not_one(monkeypatch, tmp_path):
    _probe_dotenv(monkeypatch, tmp_path)
    monkeypatch.delenv("TT_DISABLE_DOTENV", raising=False)
    module = _load_config_fresh()
    assert module.Settings.model_config["env_file"] == ".env"
    assert module.settings.PROJECT_NAME == PROBE_NAME
    monkeypatch.setenv("TT_DISABLE_DOTENV", "0")
    module = _load_config_fresh()
    assert module.Settings.model_config["env_file"] == ".env"
    assert module.settings.PROJECT_NAME == PROBE_NAME


# --- the guard itself ---------------------------------------------------------------------

import os  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402

import pytest  # noqa: E402

from app.tests import _db_guard  # noqa: E402

BACKEND_DIR = Path(__file__).resolve().parents[2]
GOOD_URL = "postgresql://u:secret-pw@127.0.0.1:1/tt_test_x"
COLLECT_TARGET = "app/tests/test_budget_period.py"  # any module; conftest decides first


def _collect(url=GOOD_URL, extra_env=None, drop=()):
    """pytest --collect-only in a clean subprocess; returns (exit code, output)."""
    env = {k: v for k, v in os.environ.items()
           if k not in _db_guard.LIBPQ_ROUTING_VARS and k not in drop}
    env.pop("DATABASE_URL", None)
    if url is not None:
        env["DATABASE_URL"] = url
    env.update(extra_env or {})
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider",
         COLLECT_TARGET],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=120,
    )
    return proc.returncode, proc.stdout + proc.stderr


def test_guard_exits_when_database_url_is_unset():
    code, out = _collect(url=None)
    assert code != 0
    assert "DATABASE_URL" in out


@pytest.mark.parametrize("name", _db_guard.LIBPQ_ROUTING_VARS)
def test_guard_refuses_libpq_routing_environment(name):
    value = "203.0.113.5" if name == "PGHOSTADDR" else "x"
    code, out = _collect(extra_env={"REQUIRE_DB": "1", name: value})
    assert code != 0
    assert f"refusing: unset {name}" in out
    # nothing was connected to: the reachability check never ran
    assert "unreachable" not in out
    assert "secret-pw" not in out


def test_check_environment_returns_its_reason_and_imports_no_driver():
    program = (
        "import os, sys\n"
        "os.environ['PGHOSTADDR'] = '203.0.113.5'\n"
        "from app.tests import _db_guard\n"
        "print('REASON=' + str(_db_guard.check_environment()))\n"
        "print('SQLALCHEMY=' + str('sqlalchemy' in sys.modules))\n"
        "print('PSYCOPG2=' + str('psycopg2' in sys.modules))\n"
    )
    env = {k: v for k, v in os.environ.items() if k not in _db_guard.LIBPQ_ROUTING_VARS}
    proc = subprocess.run([sys.executable, "-c", program], cwd=BACKEND_DIR, env=env,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert "REASON=unset PGHOSTADDR" in proc.stdout
    assert "SQLALCHEMY=False" in proc.stdout
    assert "PSYCOPG2=False" in proc.stdout


def test_check_environment_ignores_empty_values():
    assert _db_guard.check_environment({"PGHOST": ""}) is None
    assert _db_guard.check_environment({}) is None


@pytest.mark.parametrize("url", [
    "postgresql://u:p@db.example.com:5432/tt_test_x",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x?host=db.example.com",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x?hostaddr=203.0.113.5",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x?dbname=tally_trace",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x?service=prod",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x?host=a&host=b",
    "postgresql://u:p@127.0.0.1:5432,db.example.com:5432/tt_test_x",
    "postgresql://u:p@127.0.0.1:5432/tt_test_x#frag",
    "mysql://u:p@127.0.0.1:3306/tt_test_x",
    "postgresql+asyncpg://u:p@127.0.0.1:5432/tt_test_x",
    "postgresql:///tt_test_x",
    "postgresql://u:p@db.example.com,x@localhost/tt_test_x",
    "postgresql://u:p@x@localhost/tt_test_x",
    "postgresql://u:p,x@localhost/tt_test_x",
])
def test_guard_refuses_remote_and_overridden_targets(url):
    assert _db_guard.check_test_database_url(url) is not None


def test_guard_refusal_never_prints_the_password():
    reason = _db_guard.check_test_database_url("postgresql://u:secret-pw@db.example.com/tt_test_x")
    assert reason is not None and "secret-pw" not in reason


def test_guard_refuses_a_local_dev_database_name():
    assert _db_guard.check_test_database_url(
        "postgresql://u:p@127.0.0.1:5432/tally_trace") is not None


@pytest.mark.parametrize("url", [
    "postgresql://u:p@127.0.0.1:5432/tt_test_stu343a_t1",
    "postgresql://u:p@localhost:5432/tally_trace_test",
    "postgresql://u:p@[::1]:5432/tt_test_x",
    "postgresql+psycopg2://u:p@127.0.0.1:5432/tt_test_x",
    "postgresql://u:p%40ss@127.0.0.1:5432/tt_test_x",  # an escaped @ in the password
])
def test_guard_accepts_throwaway_names(url):
    assert _db_guard.check_test_database_url(url) is None


@pytest.mark.parametrize("name", ["tt_testx", "TT_TEST_A", "postgres"])
def test_guard_refuses_other_names(name):
    assert _db_guard.check_test_database_url(f"postgresql://u:p@127.0.0.1:5432/{name}") is not None


def test_app_engine_targets_the_guarded_database():
    from urllib.parse import urlsplit

    from app.core.config import Settings
    from app.core.database import engine

    guarded = urlsplit(os.environ["DATABASE_URL"])
    assert engine.url.host == guarded.hostname
    assert engine.url.database == guarded.path[1:]
    assert not engine.url.query
    assert os.environ["TT_DISABLE_DOTENV"] == "1"
    assert Settings.model_config["env_file"] is None


def test_require_db_turns_unreachable_into_exit():
    code, out = _collect(extra_env={"REQUIRE_DB": "1"})  # 127.0.0.1:1 refuses connections
    assert code != 0
    assert "unreachable" in out
    assert "secret-pw" not in out
