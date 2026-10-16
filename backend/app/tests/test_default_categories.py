"""The default category definitions: well-formed, no database needed."""
import re

from app.core.categories import DEFAULT_CATEGORIES


def test_there_are_22_defaults_with_unique_names():
    names = [c["name"] for c in DEFAULT_CATEGORIES]
    assert len(names) == 22
    assert len(set(names)) == 22


def test_every_default_has_a_known_kind_and_a_hex_colour():
    for c in DEFAULT_CATEGORIES:
        assert c["kind"] in {"expense", "income", "transfer"}, c
        assert re.fullmatch(r"#[0-9A-Fa-f]{6}", c["color"]), c
        assert c["description"], c
