"""The default category definitions: well-formed, no database needed."""
import re

from app.core.categories import DEFAULT_CATEGORIES


def test_there_are_23_defaults_with_unique_names():
    names = [c["name"] for c in DEFAULT_CATEGORIES]
    assert len(names) == 23
    assert len(set(names)) == 23


def test_gifts_given_is_an_expense_default():
    names = [c["name"] for c in DEFAULT_CATEGORIES]
    gifts = DEFAULT_CATEGORIES[names.index("Gifts & Donations")]
    assert gifts == {"name": "Gifts & Donations", "description": "Gifts and donations given",
                     "color": "#E599F7", "kind": "expense"}
    assert names.index("Gifts & Donations") == names.index("Fees & Charges") + 1


def test_every_default_has_a_known_kind_and_a_hex_colour():
    for c in DEFAULT_CATEGORIES:
        assert c["kind"] in {"expense", "income", "transfer"}, c
        assert re.fullmatch(r"#[0-9A-Fa-f]{6}", c["color"]), c
        assert c["description"], c
