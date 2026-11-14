"""Deterministic and CPU measurements of one request, shared by the budget tests and
``backend/scripts/perf_bench.py`` (STU-596).

``measure`` runs a GET in-process and returns a ``Sample``:

``statements``     SQL statements the request executed (an engine event)
``bytes``          size of the JSON body with every id normalised to six digits, so
                   the figure does not move with the database's sequences
``statement_day``  calls to ``statements.statement_day``
``collect_events`` calls to ``forecast.collect_events``
``instances``      ORM instances loaded (``loaded_as_persistent``)
``access_maps``    ``AccessMap`` reads (``access._build_access_map``), the viewable
                   accounts and roles, for the user read most often (STU-598)
``record_access``  ``RecordAccess`` objects built, for the user built most often
``redactors``      ``Redactor`` objects built, for the user built most often
``contexts``       ``RequestContext`` objects built (``core/context.py``), in all
``cpu_ms``         ``time.process_time`` for the request (median of ``runs``)
``wall_ms``       wall clock for the request (median of ``runs``)

All but the last two are exact and repeat run to run, so a test can gate on them. The
last two depend on the machine and are only reported (and gated at a generous multiple).
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Dict, List

from sqlalchemy import event
from sqlalchemy.orm import Session

COUNTED_CALLS = ("statement_day", "collect_events")
PER_USER = ("access_maps", "record_access", "redactors")
_CANON_ID = 100_000


@dataclass
class Sample:
    statements: int
    bytes: int
    statement_day: int
    collect_events: int
    instances: int
    cpu_ms: float
    wall_ms: float
    access_maps: int = 0
    record_access: int = 0
    redactors: int = 0
    contexts: int = 0


def _canonical(node, key=None):
    if isinstance(node, dict):
        return {k: _canonical(v, k) for k, v in node.items()}
    if isinstance(node, list):
        return [_canonical(v, key) for v in node]
    if (isinstance(node, int) and not isinstance(node, bool) and key is not None
            and (key == "id" or key.endswith("_id") or key.endswith("_ids"))):
        return _CANON_ID
    return node


def canonical_bytes(content: bytes) -> int:
    """Length of the response JSON with every ``id`` / ``*_id`` / ``*_ids`` integer set
    to the same six-digit figure, compact-encoded."""
    body = _canonical(json.loads(content))
    return len(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode())


class _Counters:
    """Counts the work in one request. Install with ``with``; not re-entrant."""

    def __init__(self, engine):
        self.engine = engine
        self.statements = 0
        self.instances = 0
        self.calls: Dict[str, int] = {n: 0 for n in COUNTED_CALLS}
        # Per user: what the request built for that user (``_count_per_user``).
        self.per_user: Dict[str, Counter] = {n: Counter() for n in PER_USER}
        self.contexts = 0
        self._patched: List[tuple] = []

    def _statement(self, *args):
        self.statements += 1

    def _instance(self, *args):
        self.instances += 1

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._statement)
        event.listen(Session, "loaded_as_persistent", self._instance)
        # Each function is bound by name in every module that imported it, so replace
        # the name wherever it is the original (the module attribute is what a call reads).
        for name in COUNTED_CALLS:
            originals = {}
            for mod_name, module in list(sys.modules.items()):
                if mod_name.startswith("app.") and not mod_name.startswith("app.tests"):
                    fn = getattr(module, name, None)
                    if callable(fn):
                        originals[mod_name] = fn
            canonical = next((fn for m, fn in originals.items()
                              if m in ("app.services.statements", "app.services.forecast")), None)
            if canonical is None:
                continue

            def make(fn, name=name):
                def wrapper(*a, **kw):
                    self.calls[name] += 1
                    return fn(*a, **kw)
                return wrapper

            wrapped = make(canonical)
            for mod_name, fn in originals.items():
                if fn is canonical:
                    module = sys.modules[mod_name]
                    self._patched.append((module, name, fn))
                    setattr(module, name, wrapped)
        self._count_per_user()
        return self

    def _count_per_user(self) -> None:
        """Count, by user id, each ``AccessMap`` read and each ``RecordAccess`` and
        ``Redactor`` built, and each ``RequestContext`` built: ``access._build_access_map``
        is read by name from its module, the constructors from their classes."""
        from app.core import access
        from app.core.context import RequestContext
        from app.core.redaction import Redactor

        def on_build(fn):
            def wrapper(db, uid, *a, **kw):
                self.per_user["access_maps"][uid] += 1
                return fn(db, uid, *a, **kw)
            return wrapper

        def on_init(fn, name):
            def wrapper(obj, db, user, *a, **kw):
                self.per_user[name][getattr(user, "id", user)] += 1
                return fn(obj, db, user, *a, **kw)
            return wrapper

        def on_context(fn):
            def wrapper(obj, *a, **kw):
                self.contexts += 1
                return fn(obj, *a, **kw)
            return wrapper

        for target, attr, wrapped in (
                (RequestContext, "__init__", on_context(RequestContext.__init__)),
                (access, "_build_access_map", on_build(access._build_access_map)),
                (access.RecordAccess, "__init__",
                 on_init(access.RecordAccess.__init__, "record_access")),
                (Redactor, "__init__", on_init(Redactor.__init__, "redactors"))):
            self._patched.append((target, attr, getattr(target, attr)))
            setattr(target, attr, wrapped)

    def most_per_user(self, name: str) -> int:
        return max(self.per_user[name].values(), default=0)

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._statement)
        event.remove(Session, "loaded_as_persistent", self._instance)
        for module, name, fn in reversed(self._patched):
            setattr(module, name, fn)
        self._patched.clear()


def measure(client, headers, path: str, runs: int = 5) -> Sample:
    """Warm the endpoint, count its work in one run, then time ``runs`` more runs
    (CPU and wall as the median)."""
    from app.core.database import engine

    url = f"/api/v1{path}"
    warm = client.get(url, headers=headers)
    assert warm.status_code == 200, (path, warm.status_code, warm.text[:300])
    with _Counters(engine) as c:  # counted on its own: the wrappers cost CPU
        r = client.get(url, headers=headers)
    counts = (c.statements, canonical_bytes(r.content), c.calls["statement_day"],
              c.calls["collect_events"], c.instances)
    per_user = {name: c.most_per_user(name) for name in PER_USER}
    per_user["contexts"] = c.contexts
    cpu: List[float] = []
    wall: List[float] = []
    for _ in range(max(runs, 1)):
        w0, c0 = time.perf_counter(), time.process_time()
        r = client.get(url, headers=headers)
        c1, w1 = time.process_time(), time.perf_counter()
        assert r.status_code == 200, (path, r.status_code)
        cpu.append((c1 - c0) * 1000)
        wall.append((w1 - w0) * 1000)
    return Sample(*counts, cpu_ms=statistics.median(cpu), wall_ms=statistics.median(wall),
                  **per_user)


# --- the requests the budgets and the benchmark cover -----------------------------------------

def _window(today: date):
    month_start = today.replace(day=1)
    return month_start, today, today + timedelta(days=1), today + timedelta(days=30)


def hot_paths(world, caller: str) -> Dict[str, str]:
    """The hot endpoints, as the web app calls them, for one caller of ``world``."""
    today = world.today
    month_start, _, _, _ = _window(today)
    card = world.statement_card[caller]
    paths = {
        "snapshot": "/dashboard/snapshot",
        "installment-plans": f"/budget-entries/installment-plans?day={today}",
        "budget-entries": "/budget-entries/?is_active=true&limit=200",
        "accounts": "/accounts/?is_active=true&limit=100",
        "transactions": (f"/transactions/?start_date={month_start}T00:00:00"
                         f"&end_date={today}T23:59:59&limit=25&offset=0"),
    }
    if caller == "household":
        # A tag viewer reads the owner's records through the household views only.
        owner = world.callers["owner"].id
        paths["household-upcoming"] = f"/household/{owner}/upcoming"
        paths["household-monthly"] = f"/household/{owner}/monthly"
        paths["household-dashboard"] = f"/household/{owner}/dashboard"
        return paths
    paths["statements"] = f"/accounts/{card}/statements"
    if caller == "owner":  # owner or admin only: others get a 404
        paths["card-credit"] = f"/cards/{card}/credit"
    return paths


def page_open_paths(world) -> Dict[str, str]:
    """The requests the Transactions page makes on open (root-cause report, RC1)."""
    today = world.today
    month_start, _, tomorrow, horizon = _window(today)
    return {
        "snapshot": "/dashboard/snapshot",
        "transactions (month, 25)": (f"/transactions/?start_date={month_start}T00:00:00"
                                     f"&end_date={today}T23:59:59&limit=25&offset=0"),
        "accounts": "/accounts/?is_active=true&limit=100",
        "categories": "/categories/?is_active=true",
        "budget-entries": "/budget-entries/?is_active=true&limit=200",
        "due window (unposted)": (f"/transactions/?is_posted=false&end_date={horizon}T23:59:59"
                                  "&limit=1000&offset=0"),
        "upcoming transactions": (f"/transactions/?start_date={tomorrow}T00:00:00"
                                  f"&end_date={horizon}T23:59:59&order=asc&limit=100&offset=0"),
        "upcoming occurrences (none)": (f"/budget-entries/upcoming-occurrences?start_date="
                                        f"{tomorrow}T00:00:00&end_date={horizon}T23:59:59"
                                        "&plan=none&limit=500"),
        "upcoming occurrences (subscription)": (f"/budget-entries/upcoming-occurrences?"
                                                f"start_date={tomorrow}T00:00:00&end_date="
                                                f"{horizon}T23:59:59&plan=subscription&limit=500"),
        "installment-plans": f"/budget-entries/installment-plans?day={today}",
        "scheduled": "/transactions/scheduled",
    }


# What the web app refetches after one save (root-cause report: ~8 requests).
POST_SAVE_KEYS = ("snapshot", "transactions (month, 25)", "accounts", "budget-entries",
                  "due window (unposted)", "upcoming transactions", "installment-plans",
                  "categories")


def post_save_paths(world) -> Dict[str, str]:
    paths = page_open_paths(world)
    return {k: paths[k] for k in POST_SAVE_KEYS}
