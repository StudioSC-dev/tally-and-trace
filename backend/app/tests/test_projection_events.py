"""Unit tests for the unified dated-event projection engine (pure, no database)."""
from types import SimpleNamespace

from app.models.account import AccountType
from app.services.forecast import is_projection_cash


def test_is_projection_cash_excludes_credit_cards_only():
    for t in (AccountType.CASH, AccountType.E_WALLET, AccountType.SAVINGS, AccountType.CHECKING):
        assert is_projection_cash(SimpleNamespace(account_type=t)) is True
    assert is_projection_cash(SimpleNamespace(account_type=AccountType.CREDIT)) is False
