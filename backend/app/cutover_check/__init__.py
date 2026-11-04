"""Read-only cutover check (STU-204): compares the database with frozen figures.

Kept free of imports so the wrapper can load ``bootstrap`` before any app module.
It imports nothing from ``app.cutover_load``.

Historical: the cutover is done and will not be re-run. Its frozen statement
dues predate the banking-day roll and per-statement due overrides
(``card_statement_due_overrides``), which the cycle walk now applies, so a
frozen due can differ from the one computed today (docs/cutover-check.md).
"""
