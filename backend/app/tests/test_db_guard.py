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


def test_dotenv_is_skipped_when_tt_disable_dotenv_is_set(monkeypatch):
    monkeypatch.setenv("TT_DISABLE_DOTENV", "1")
    module = _load_config_fresh()
    assert module.Settings.model_config["env_file"] is None


def test_dotenv_is_read_when_tt_disable_dotenv_is_unset_or_not_one(monkeypatch):
    monkeypatch.delenv("TT_DISABLE_DOTENV", raising=False)
    assert _load_config_fresh().Settings.model_config["env_file"] == ".env"
    monkeypatch.setenv("TT_DISABLE_DOTENV", "0")
    assert _load_config_fresh().Settings.model_config["env_file"] == ".env"
