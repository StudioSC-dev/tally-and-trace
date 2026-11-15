"""The cutover runbook and the reset's wording say what the tool does (STU-311)."""
import re
from pathlib import Path

DOC = Path(__file__).resolve().parents[3] / "docs" / "cutover-load.md"


def _text() -> str:
    """The runbook with line wraps collapsed, so a sentence matches wherever it wraps."""
    return re.sub(r"\s+", " ", DOC.read_text())


def _migrations_section() -> str:
    section = re.search(r"## Migrations\n(.*?)\n## ", DOC.read_text(), re.S)
    assert section, "no Migrations section"
    return re.sub(r"\s+", " ", section.group(1))


def test_loader_lock_duration():
    assert ("The loader holds the owner's advisory lock (226) and account row locks for "
            "the entire load, including dry runs; the owner's app writes queue behind it."
            ) in _text()


def test_migration_deployment_restriction():
    assert ("Production deployments run `alembic upgrade head` through the `render.yaml` "
            "buildCommand. Nothing may be merged or deployed between a load and its reset "
            "or sign-off.") in _migrations_section()


def test_both_commands_refuse_fingerprint_mismatch():
    section = _migrations_section()
    assert "the reset and `--complete-record` then refuse" in section
    assert "the reset then refuses" not in section
