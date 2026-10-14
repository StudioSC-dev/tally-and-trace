"""The read-only cutover check (STU-204, plan v3 §2.5, tests §2.6 C3 1-9).

State is built through the app's own write paths (the HTTP API and the shared
``sw_`` fixtures), never through the cutover loader. Every figure is invented.
"""
import copy
import json
import os
import stat

import pytest

from app.cutover_check import bootstrap, schema

DATA = os.path.join(os.path.dirname(__file__), "data", "cutover_check")


def frozen_base() -> dict:
    with open(os.path.join(DATA, "frozen_base.json"), encoding="utf-8") as handle:
        return json.load(handle)


def refused(raw: dict, fragment: str) -> None:
    with pytest.raises(schema.FrozenError) as caught:
        schema.parse_frozen(raw)
    assert fragment in str(caught.value), str(caught.value)


# --- Schema (cutover-frozen v1) ----------------------------------------------------------------

def test_schema_accepts_the_base_fixture():
    frozen = schema.parse_frozen(frozen_base())
    assert frozen.as_of.isoformat() == "2031-03-10"
    assert str(frozen.card_statements[0].owed) == "600.00"


def test_schema_refuses_an_unknown_version():
    raw = frozen_base()
    raw["schema_version"] = 2
    refused(raw, "unknown schema_version 2")


def test_schema_refuses_unknown_keys():
    raw = frozen_base()
    raw["loans"][0]["surprise"] = 1
    refused(raw, "Extra inputs are not permitted")


def test_schema_refuses_money_finer_than_a_cent_or_not_a_string():
    raw = frozen_base()
    raw["card_statements"][0]["owed"] = "600.001"
    refused(raw, "at most 2 places")
    raw = frozen_base()
    raw["card_statements"][0]["owed"] = 600
    refused(raw, "decimal string")


def test_schema_refuses_a_duplicate_recurring_triple():
    raw = frozen_base()
    raw["recurring"].append(copy.deepcopy(raw["recurring"][0]))
    refused(raw, "unique by (name, account, destination)")


def test_schema_refuses_a_first_month_before_the_cutover():
    raw = frozen_base()
    raw["cutover_date"] = "2031-03-02"
    refused(raw, "first_month must start on or after cutover_date")


def test_schema_refuses_month_end_that_does_not_match_the_months():
    raw = frozen_base()
    del raw["sheet"]["month_end"]["2031-05"]
    refused(raw, "month_end must hold exactly")


def test_schema_refuses_more_than_three_loan_rows():
    raw = frozen_base()
    raw["loans"][0]["next_rows"].append({"due_date": "2031-07-20", "payment": "5000.00"})
    refused(raw, "first 3")


def test_schema_refuses_installment_without_after_occurrences():
    raw = frozen_base()
    raw["recurring"][0]["installment"] = {"n": 1, "m": 2}
    refused(raw, "installment goes with end_mode after_occurrences")


def test_schema_refuses_gaps_in_expected_months():
    raw = frozen_base()
    raw["recurring"][0]["expected"] = {"2031-03": 1, "2031-05": 1}
    refused(raw, "contiguous")


def test_schema_refuses_a_sheet_currency_other_than_its_account():
    raw = frozen_base()
    raw["sheet"]["currency"] = "USD"
    refused(raw, "sheet.currency must be the sheet account's currency")


# --- Bootstrap: URL validation (no connection) -------------------------------------------------

LOCAL = "postgresql://u:secret@127.0.0.1:5432/c3db"


def test_url_validation_accepts_a_plain_url_and_sslmode_prefer():
    assert bootstrap.validate_url(LOCAL, "127.0.0.1", "c3db", {}).host == "127.0.0.1"
    url = bootstrap.validate_url(LOCAL + "?sslmode=prefer", "127.0.0.1", "c3db", {})
    assert url.query["sslmode"] == "prefer"


@pytest.mark.parametrize("raw, fragment", [
    (LOCAL + "?host=10.0.0.9", "query key 'host' is not allowed"),
    (LOCAL + "?hostaddr=10.0.0.9", "query key 'hostaddr' is not allowed"),
    (LOCAL + "?port=6543", "query key 'port' is not allowed"),
    (LOCAL + "?dbname=other", "query key 'dbname' is not allowed"),
    (LOCAL + "?service=prod", "query key 'service' is not allowed"),
    (LOCAL + "?options=-csearch_path%3Dx", "query key 'options' is not allowed"),
    (LOCAL + "?sslmode=require&sslmode=disable", "query key 'sslmode' is repeated"),
    ("mysql://u:secret@127.0.0.1/c3db", "driver"),
    ("postgresql+asyncpg://u:secret@127.0.0.1/c3db", "driver"),
    ("postgresql://u:secret@/c3db", "exactly one host"),
    ("postgresql://u:secret@127.0.0.1:5432/other", "is not --expect-db"),
    ("postgresql://u:secret@10.1.1.1:5432/c3db", "is not --expect-host"),
])
def test_url_validation_refuses_target_overrides(raw, fragment):
    with pytest.raises(bootstrap.BootstrapError) as caught:
        bootstrap.validate_url(raw, "127.0.0.1", "c3db", {})
    assert fragment in str(caught.value)
    assert "secret" not in str(caught.value)


@pytest.mark.parametrize("name", bootstrap.FORBIDDEN_ENV)
def test_url_validation_refuses_libpq_environment_overrides(name):
    with pytest.raises(bootstrap.BootstrapError) as caught:
        bootstrap.validate_url(LOCAL, "127.0.0.1", "c3db", {name: "10.0.0.9"})
    assert name in str(caught.value)


def test_url_validation_refuses_a_missing_url():
    with pytest.raises(bootstrap.BootstrapError, match="DATABASE_URL is not set"):
        bootstrap.validate_url("", "127.0.0.1", "c3db", {})


# --- Bootstrap: output and input paths --------------------------------------------------------

def test_paths_inside_the_repo_are_refused_even_through_a_symlink(tmp_path):
    root = bootstrap.repo_root()
    with pytest.raises(bootstrap.BootstrapError, match="outside the repository"):
        bootstrap.require_outside_repo(os.path.join(root, "backend", "report.json"), "report")
    link = tmp_path / "into-repo"
    link.symlink_to(os.path.join(root, "backend"))
    with pytest.raises(bootstrap.BootstrapError, match="outside the repository"):
        bootstrap.require_outside_repo(str(link / "report.json"), "report")
    outside = bootstrap.require_outside_repo(str(tmp_path / "report.json"), "report")
    assert outside == os.path.realpath(tmp_path / "report.json")


def test_relative_paths_resolve_against_the_original_directory(tmp_path):
    resolved = bootstrap.absolute("out/report.json", cwd=str(tmp_path))
    assert resolved == os.path.realpath(tmp_path / "out" / "report.json")


def test_private_files_are_0600_and_never_replaced(tmp_path):
    path = str(tmp_path / "report.json")
    bootstrap.create_private(path, "{}")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with pytest.raises(FileExistsError):
        bootstrap.create_private(path, "{}")
