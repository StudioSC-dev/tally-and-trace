"""Cutover load (STU-202): one owner's opening figures, loaded through the app's write paths.

``schema`` and ``validate`` read and check the ``cutover-input`` v1 file without
touching a database. ``bootstrap`` and ``outputs`` hold the connection and file
rules (no ``app`` import, so they run before the app is imported). ``loader``
writes, ``reset`` undoes a load inside the maintenance window, and both run
through ``backend/scripts/cutover_load.py``. See ``docs/cutover-load.md``.

Nothing is imported here, so importing ``app.cutover_load.bootstrap`` imports
no other part of the app.
"""
