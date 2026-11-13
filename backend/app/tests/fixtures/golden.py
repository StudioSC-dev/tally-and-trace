"""Golden responses of the hot endpoints on the realistic dataset (STU-597).

A refactor that must not change what any caller sees (PERF-2's access map, PERF-3's
per-request context) is checked against these files: every hot endpoint, for the four
callers of ``app/tests/fixtures/realistic.py`` and a stranger who holds nothing,
captured once at the commit before the refactor and compared byte for byte.

``golden_paths``  the requests, per caller (the budget paths, plus the statements and
                  credit endpoints for every caller, so the denials are pinned too)
``canonical``     the response as compared: status and JSON body, with every
                  ``id`` / ``*_id`` / ``*_ids`` integer normalised as the budgets do
                  (``perf._canonical``), row timestamps the database stamps
                  (``created_at``, ``updated_at``) blanked, and lists the endpoint
                  returns in no defined order sorted (``UNORDERED``), and rows
                  tied on their date put in a fixed order (``TIE_KEYS``)
``capture``       every golden request for one caller, as ``{name: text}``

Files live in ``app/tests/data/golden/realistic/<caller>--<endpoint>.json``. To
re-capture (only on purpose, at a commit whose behaviour is the reference):

    GOLDEN_UPDATE=1 pytest app/tests/test_golden_endpoints.py

Nothing here may import ``app.tests.conftest`` (see ``realistic.py``).
"""
from __future__ import annotations

import json
import secrets
from pathlib import Path
from typing import Dict, Tuple

from app.tests.fixtures import perf
from app.tests.fixtures.realistic import API, PASSWORD, Caller

GOLDEN_DIR = Path(__file__).resolve().parent.parent / "data" / "golden" / "realistic"
GOLDEN_CALLERS = ("owner", "editor", "viewer", "household", "stranger")

# Keys whose values the database stamps at insert or update time: they move with the
# wall clock, not with the code.
STAMPED_KEYS = frozenset({"created_at", "updated_at"})
STAMPED = "<stamped>"

# Lists the endpoint builds from a query with no ORDER BY, so their order is whatever
# the heap returns (it moves between builds). Path from the body's root, ``[]`` for
# "every element of a list". Each is sorted by its JSON text before comparing.
UNORDERED: Tuple[Tuple[str, ...], ...] = (
    ("balances", "by_account"),  # dashboard snapshot: viewable_accounts(...).all()
)


def _blank_stamps(node):
    if isinstance(node, dict):
        return {k: (STAMPED if k in STAMPED_KEYS and v is not None else _blank_stamps(v))
                for k, v in node.items()}
    if isinstance(node, list):
        return [_blank_stamps(v) for v in node]
    return node


# Lists of rows ordered by a date alone: rows on the same date come in whatever order
# the query returned them (no tiebreaker), which moves between builds. Within each run
# of consecutive rows on the same date (each row's first of these keys; a list mixes
# full rows, keyed ``due_date``, with limited ones, keyed ``date``), rows are sorted
# by their JSON text; the order between dates is still compared.
TIE_KEYS = ("due_date", "date", "occurrence_date", "transaction_date")
_NO_DATE = object()


def _sort_ties(node):
    if isinstance(node, dict):
        for v in node.values():
            _sort_ties(v)
        return
    if not isinstance(node, list):
        return
    for v in node:
        _sort_ties(v)
    if not node or not all(isinstance(v, dict) for v in node):
        return
    dates = [next((v[k] for k in TIE_KEYS if k in v), _NO_DATE) for v in node]
    if _NO_DATE in dates:
        return
    i = 0
    while i < len(node):
        j = i
        while j + 1 < len(node) and dates[j + 1] == dates[i]:
            j += 1
        if j > i:
            node[i:j + 1] = sorted(node[i:j + 1], key=lambda v: json.dumps(v, sort_keys=True))
        i = j + 1


def _sort_at(node, path: Tuple[str, ...]):
    if not path:
        if isinstance(node, list):
            node.sort(key=lambda v: json.dumps(v, sort_keys=True))
        return
    head, rest = path[0], path[1:]
    if head == "[]":
        for item in node if isinstance(node, list) else ():
            _sort_at(item, rest)
    elif isinstance(node, dict) and head in node:
        _sort_at(node[head], rest)


def canonical(status: int, content: bytes) -> str:
    """The text a golden file holds for one response."""
    try:
        body = json.loads(content)
    except ValueError:
        body = {"<non-json>": content.decode("utf-8", "replace")}
    body = _blank_stamps(perf._canonical(body))
    for path in UNORDERED:
        _sort_at(body, path)
    _sort_ties(body)
    return json.dumps({"status": status, "body": body}, indent=1, sort_keys=True,
                      ensure_ascii=False) + "\n"


def golden_paths(world, caller: str) -> Dict[str, str]:
    """The golden requests for ``caller`` (one of ``GOLDEN_CALLERS``).

    The stranger asks for everything the others ask for, on the owner's records: each
    must come back empty or 404.
    """
    as_caller = "owner" if caller == "stranger" else caller
    paths = dict(perf.hot_paths(world, as_caller))
    card = world.statement_card[as_caller]
    paths.setdefault("statements", f"/accounts/{card}/statements")
    paths.setdefault("card-credit", f"/cards/{card}/credit")
    if caller == "stranger":
        owner = world.callers["owner"].id
        paths["household-upcoming"] = f"/household/{owner}/upcoming"
    return paths


def golden_file(caller: str, name: str) -> Path:
    return GOLDEN_DIR / f"{caller}--{name}.json"


def capture(client, world, caller: Caller, key: str) -> Dict[str, str]:
    """Every golden request for ``caller`` (whose ``GOLDEN_CALLERS`` name is ``key``)."""
    out = {}
    for name, path in golden_paths(world, key).items():
        r = client.get(f"{API}{path}", headers=caller.headers)
        out[name] = canonical(r.status_code, r.content)
    return out


def make_stranger(client, db, tag: str = "golden") -> Caller:
    """A verified user who holds no role on anything of the realistic dataset."""
    from app.core.auth import get_password_hash
    from app.models.user import User

    user = User(email=f"{tag}-stranger-{secrets.token_hex(4)}@example.com",
                password_hash=get_password_hash(PASSWORD), first_name="Stranger",
                last_name="Perf", is_verified=True)
    db.add(user)
    db.commit()
    db.refresh(user)
    return Caller("stranger", user.id, user.email, client)


def remove_stranger(db, stranger: Caller) -> None:
    from app.models.tag import Tag
    from app.models.user import User

    db.rollback()
    db.query(Tag).filter(Tag.user_id == stranger.id).delete(synchronize_session=False)
    db.query(User).filter(User.id == stranger.id).delete(synchronize_session=False)
    db.commit()
