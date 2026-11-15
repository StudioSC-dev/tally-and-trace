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


# --- the reset's snapshot wording and the end-to-end docstring -----------------------

APP = Path(__file__).resolve().parents[1]
RESET = APP / "cutover_load" / "reset.py"
LOAD_TESTS = APP / "tests" / "test_cutover_load_integration.py"


def _squash(text: str) -> str:
    """Collapse comment markers and line wraps."""
    return re.sub(r"\s+", " ", re.sub(r"^\s*#", " ", text, flags=re.M))


def test_reset_snapshot_comment():
    comment = _squash(RESET.read_text())
    assert ("REPEATABLE READ: the counts, the fingerprint and the deletes read one snapshot, "
            "fixed by the first statement (the lock). A concurrent change to a row the reset "
            "deletes makes it fail with a serialization error. A row another transaction "
            "inserts after the snapshot is not seen, so the owner's writes must queue behind "
            "the lock (STU-226).") in comment
    assert "so the deletes act on exactly the state" not in comment


def test_reset_snapshot_test_name_and_docstring():
    source = LOAD_TESTS.read_text()
    assert "def test_reset_runs_at_repeatable_read(" not in source
    match = re.search(r"def test_reset_reads_one_repeatable_read_snapshot\(.*?\):\n"
                      r'    """(.*?)"""', source, re.S)
    assert match, "the renamed snapshot test is missing"
    assert match.group(1) == "The counts and the fingerprint are read in one REPEATABLE READ snapshot."


def test_end_to_end_docstring_names_account_and_checkpoint():
    source = _squash(LOAD_TESTS.read_text())
    assert "makes the check fail and name the account and checkpoint." in source
    assert "name that row" not in source and "names that row" not in source
