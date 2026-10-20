"""Category names are unique per (name, kind) within the caller's own categories (STU-384).

An income and an expense category may share a name, and so may a transfer category
beside either. A second category of the same kind and name is refused with 400, on
create and on update (a change of name, of kind, or of both). Inactive categories
still block their (name, kind). Skips without a database.
"""
import os
import uuid

import pytest
from sqlalchemy import create_engine, text


def _db_reachable() -> bool:
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False
    try:
        with create_engine(url).connect() as c:
            c.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_reachable(), reason="no database available")

API = "/api/v1"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def h(client):
    r = client.post(f"{API}/auth/login", json={"email": "demo@example.com", "password": "password123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _name():
    return f"same-{uuid.uuid4().hex[:8]}"


def _create(client, h, expect=200, **body):
    r = client.post(f"{API}/categories/", headers=h, json=body)
    assert r.status_code == expect, r.text
    return r.json()


def _update(client, h, category_id, expect=200, **body):
    r = client.put(f"{API}/categories/{category_id}", headers=h, json=body)
    assert r.status_code == expect, r.text
    return r.json()


def _taken(kind):
    return f"A category of kind '{kind}' with this name already exists"


def test_income_and_expense_may_share_a_name(client, h):
    name = _name()
    expense = _create(client, h, name=name, kind="expense")
    income = _create(client, h, name=name, kind="income")
    assert expense["id"] != income["id"]
    assert (expense["kind"], expense["is_expense"]) == ("expense", True)
    assert (income["kind"], income["is_expense"]) == ("income", False)


def test_a_second_category_of_the_same_kind_and_name_is_refused(client, h):
    name = _name()
    _create(client, h, name=name, kind="income")
    body = _create(client, h, expect=400, name=name, kind="income")
    assert body["detail"] == _taken("income")
    # The check is exact: another case or surrounding space is a different name.
    _create(client, h, name=name.upper(), kind="income")
    _create(client, h, name=f" {name}", kind="income")


def test_transfer_names_are_unique_per_kind_too(client, h):
    name = _name()
    _create(client, h, name=name, kind="income")
    _create(client, h, name=name, kind="expense")
    _create(client, h, name=name, kind="transfer")
    body = _create(client, h, expect=400, name=name, kind="transfer")
    assert body["detail"] == _taken("transfer")


def test_legacy_is_expense_create_is_checked_against_the_derived_kind(client, h):
    name = _name()
    _create(client, h, name=name, kind="income")
    # No kind and no is_expense: the default (is_expense true) makes it an expense.
    assert _create(client, h, name=name)["kind"] == "expense"
    assert _create(client, h, expect=400, name=name, is_expense=False)["detail"] == _taken("income")
    assert _create(client, h, expect=400, name=name, is_expense=True)["detail"] == _taken("expense")
    assert _create(client, h, expect=400, name=name)["detail"] == _taken("expense")


def test_renaming_into_a_same_kind_name_is_refused_and_into_another_kinds_name_is_allowed(
        client, h):
    name = _name()
    _create(client, h, name=name, kind="expense")
    other_expense = _create(client, h, name=_name(), kind="expense")
    income = _create(client, h, name=_name(), kind="income")
    body = _update(client, h, other_expense["id"], expect=400, name=name)
    assert body["detail"] == _taken("expense")
    renamed = _update(client, h, income["id"], name=name)
    assert (renamed["name"], renamed["kind"]) == (name, "income")


def test_changing_kind_alone_is_checked(client, h):
    name = _name()
    _create(client, h, name=name, kind="income")
    expense = _create(client, h, name=name, kind="expense")
    body = _update(client, h, expense["id"], expect=400, kind="income")
    assert body["detail"] == _taken("income")
    body = _update(client, h, expense["id"], expect=400, is_expense=False)
    assert body["detail"] == _taken("income")
    # Into a kind the name is free in, either way of saying it.
    moved = _update(client, h, expense["id"], kind="transfer")
    assert (moved["kind"], moved["is_expense"]) == ("transfer", False)
    back = _update(client, h, expense["id"], is_expense=True)
    assert (back["kind"], back["is_expense"]) == ("expense", True)


def test_changing_name_and_kind_together_is_checked(client, h):
    name = _name()
    _create(client, h, name=name, kind="income")
    other = _create(client, h, name=_name(), kind="expense")
    body = _update(client, h, other["id"], expect=400, name=name, kind="income")
    assert body["detail"] == _taken("income")
    moved = _update(client, h, other["id"], name=name, kind="transfer")
    assert (moved["name"], moved["kind"]) == (name, "transfer")


def test_an_update_that_keeps_name_and_kind_never_clashes_with_itself(client, h):
    name = _name()
    cat = _create(client, h, name=name, kind="expense")
    assert _update(client, h, cat["id"], color="#123456")["color"] == "#123456"
    assert _update(client, h, cat["id"], name=name, kind="expense")["name"] == name
    assert _update(client, h, cat["id"], is_expense=True)["kind"] == "expense"


def test_an_inactive_same_kind_category_still_blocks_the_name(client, h):
    name = _name()
    cat = _create(client, h, name=name, kind="expense")
    r = client.delete(f"{API}/categories/{cat['id']}", headers=h)
    assert r.status_code == 200, r.text
    assert _create(client, h, expect=400, name=name, kind="expense")["detail"] == _taken("expense")
    # Another kind is still free.
    _create(client, h, name=name, kind="income")
