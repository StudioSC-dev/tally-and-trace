"""``backend/scripts/perf_bench.py`` refuses a database that is not a local throwaway (STU-596).

It reads DATABASE_URL, applies the rule the test suite's own guard uses
(``app/tests/_db_guard.py``) and exits 2 before it imports a database driver, so it
cannot have connected anywhere. Needs no database.
"""
import os
import subprocess
import sys

import pytest

BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

REMOTE_URLS = [
    "postgresql://user:secret@db.example.com:5432/tt_test_x",   # not local
    "postgresql://user:secret@203.0.113.7:5432/tt_test_x",      # not local, no DNS needed
    "postgresql://user:secret@127.0.0.1:5432/production",       # local but not a test database
    "",                                                         # unset
]


@pytest.mark.parametrize("url", REMOTE_URLS)
def test_bench_refuses_a_database_that_is_not_a_local_throwaway(url):
    """Exit 2 before any database driver is imported, so nothing can have connected."""
    probe = (
        "import runpy, sys\n"
        "sys.argv = ['perf_bench.py', '--cpu', 'full']\n"
        "try:\n"
        "    runpy.run_path('scripts/perf_bench.py', run_name='__main__')\n"
        "except SystemExit as e:\n"
        "    print('EXIT', e.code)\n"
        "print('LOADED', [m for m in ('psycopg2', 'sqlalchemy') if m in sys.modules])\n"
    )
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    if url:
        env["DATABASE_URL"] = url
    out = subprocess.run([sys.executable, "-c", probe], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=60)
    assert "EXIT 2" in out.stdout, out.stdout + out.stderr
    assert "LOADED []" in out.stdout, out.stdout
    assert "refusing" in out.stderr
    assert "secret" not in out.stderr + out.stdout
