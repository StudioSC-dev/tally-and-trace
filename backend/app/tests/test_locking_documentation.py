"""The lock-order docstring points at the helpers it names (STU-311)."""
from app.core import locking


def test_rank_four_allocation_helper():
    rank_four = [line for line in locking.__doc__.splitlines() if line.startswith("4.")]
    assert len(rank_four) == 1
    assert "routers.transactions._lock_allocations" in rank_four[0]
    from app.routers import transactions

    assert callable(transactions._lock_allocations)
