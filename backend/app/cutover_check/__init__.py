"""Read-only cutover check (STU-204): compares the database with frozen figures.

Kept free of imports so the wrapper can load ``bootstrap`` before any app module.
It imports nothing from ``app.cutover_load``.
"""
