"""Household viewer follow-ups from the T5 audit (STU-253).

Uses the ``hh`` world (``conftest.py``): A owner, B editor on A's joint
account, C holding A's and B's Household tag shares (``tag_viewer`` on A's
Household-tagged accounts).
"""
import pytest

from app.tests.conftest import API, sw_db_reachable, sw_share

pytestmark = pytest.mark.skipif(not sw_db_reachable(), reason="DATABASE_URL not reachable")


def _call(client, who, method, path, body=None, **kw):
    return client.request(method, f"{API}{path}", json=body, headers=who["headers"], **kw)


def _get(client, who, path, **params):
    r = client.get(f"{API}{path}", headers=who["headers"], params=params)
    assert r.status_code == 200, (path, r.status_code, r.text)
    return r.json()


# --- Part 1: the details permission --------------------------------------------------------

def test_can_view_details_by_role(hh, sw_client, sw_db, sw_people):
    """AC1: true for owner, admin, editor and viewer; false for a tag viewer."""
    admin, viewer = sw_people("Ada", "Admin"), sw_people("Vic", "Viewer")
    sw_share(sw_db, hh["joint"], admin["id"], "admin", hh["a"]["id"])
    sw_share(sw_db, hh["joint"], viewer["id"], "viewer", hh["a"]["id"])
    for who, role in ((hh["a"], "owner"), (admin, "admin"), (hh["b"], "editor"),
                      (viewer, "viewer"), (hh["c"], "tag_viewer")):
        one = _get(sw_client, who, f"/accounts/{hh['joint']}")
        [listed] = [a for a in _get(sw_client, who, "/accounts/", limit=100)["items"]
                    if a["id"] == hh["joint"]]
        for body in (one, listed):
            assert body["my_role"] == role
            assert body["permissions"]["can_view_details"] is (role != "tag_viewer"), role
