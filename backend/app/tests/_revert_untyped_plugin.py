"""Pytest plugin for ``test_sw_leaks_typed.py::test_reverted_untyped_match_fails_regressions``.

Restores the leak check's old matching under typed ids: every id-like key matches,
whatever kind the id is, while typed-input handling stays. Each match the typed
matcher would have refused is appended to the file named by ``SW_REVERT_LOG``, as
JSON lines keyed by the running test. Loaded with ``-p`` in a child pytest run only.
"""
import json
import os

import pytest


@pytest.fixture(autouse=True)
def _cross_kind_matching(request, monkeypatch):
    from app.tests import conftest

    typed = conftest.sw_kind_matches

    def untyped(kind, key, own):
        hit = conftest.sw_idish(key)
        if hit and not typed(kind, key, own):
            with open(os.environ["SW_REVERT_LOG"], "a") as log:
                log.write(json.dumps({"test": request.node.name, "kind": kind, "key": key}) + "\n")
        return hit

    monkeypatch.setattr(conftest, "sw_kind_matches", untyped)
