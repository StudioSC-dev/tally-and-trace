"""The cutover load against a real database (STU-202; plan v3, sections 2.2 to 2.4, 2.6).

Runs ``app.cutover_load`` in-process (and ``scripts/cutover_load.py`` as a
subprocess for the bootstrap cases) on the synthetic fixtures in
``data/cutover_load/`` (invented round figures). Every input and output file
lives in pytest's temporary directory, outside the repository.

**Skip gate.** These tests write and reset rows, so they run only against a
local database: the effective ``settings.DATABASE_URL`` must equal the exported
``DATABASE_URL``, the URL must pass the cutover's own URL validation with a
host of ``localhost``, ``127.0.0.1`` or ``::1``, and the server must report a
loopback or private address (a database in a local container reports its
container address, never a loopback one).
"""
import ipaddress
import json
import os
import stat
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.tests.conftest import hh_household

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "data", "cutover_load")
BACKEND = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(BACKEND, "scripts", "cutover_load.py")
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def _gate():
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return False, "DATABASE_URL is not set", None
    from app.core.config import settings

    if settings.DATABASE_URL != url:
        return False, "the effective settings URL is not the exported DATABASE_URL", None
    from app.cutover_load import bootstrap

    try:
        parsed = make_url(url)
        bootstrap.check_pg_environment()
        bootstrap.validate_url(url, expect_host=parsed.host or "", expect_db=parsed.database or "")
    except Exception as exc:
        return False, f"the URL fails the cutover validation ({type(exc).__name__})", None
    if parsed.host not in LOCAL_HOSTS:
        return False, "the database host is not local", None
    try:
        engine = create_engine(url)
        with engine.connect() as conn:
            address = conn.execute(text("SELECT host(inet_server_addr())")).scalar()
        engine.dispose()
    except Exception:
        return False, "the database is not reachable", None
    if address is None:
        return False, "connected over a Unix socket", None
    ip = ipaddress.ip_address(address)
    if not (ip.is_loopback or ip.is_private):
        return False, "the server address is neither loopback nor private", None
    return True, "", {"url": url, "host": parsed.host, "db": parsed.database, "addr": address}


OK, REASON, TARGET = _gate()
pytestmark = pytest.mark.skipif(not OK, reason=REASON)


# --- Helpers -------------------------------------------------------------------------------

def fixture(name="base") -> dict:
    with open(os.path.join(DATA, f"{name}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def write_input(tmp_path, data, who, name="input.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps({**data, "owner_email": who["email"]}))
    return str(path)


def mode_of(path) -> int:
    return stat.S_IMODE(os.stat(path).st_mode)


@pytest.fixture
def owner(sw_people, sw_db):
    who = sw_people("Owen", "Cutover")
    who["household"] = hh_household(sw_db, who)
    return who


# --- Tests 13 and 14: outputs, hermetic bootstrap, target ----------------------------------

HARNESS = """
import runpy, sys
script = sys.argv[1]
sys.argv = [script, *sys.argv[2:]]
code = 0
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as exc:
    code = exc.code
print("APP_IMPORTED=" + str("app.core.config" in sys.modules))
sys.exit(code)
"""


def run_wrapper(args, *, cwd, url=None, extra_env=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("PG") and k not in ("SECRET_KEY", "ENVIRONMENT")}
    env["DATABASE_URL"] = url or TARGET["url"]
    env.update(extra_env or {})
    return subprocess.run([sys.executable, "-I", "-c", HARNESS, SCRIPT, *args], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=120)


def target_args(host=None, db=None, addr=None):
    args = ["--expect-host", host or TARGET["host"], "--expect-db", db or TARGET["db"]]
    if addr:
        args += ["--expect-server-addr", addr]
    return args


def test_the_lock_key_is_the_cutover_checks():
    from app.cutover_load.bootstrap import CUTOVER_LOCK_KEY

    # Must equal CUTOVER_LOCK_KEY in app/cutover_check/bootstrap.py: the check takes
    # the shared lock on the same bigint key that the load and the reset take.
    assert CUTOVER_LOCK_KEY == 2_024_020_204


def test_an_output_inside_the_repo_is_refused_even_through_a_symlink(tmp_path, owner, sw_db):
    from app.cutover_load.outputs import repo_root

    path = write_input(tmp_path, fixture(), owner)
    inside = os.path.join(BACKEND, "cutover-report.json")
    link = tmp_path / "into-repo"
    link.symlink_to(os.path.join(repo_root(), "backend"))
    for report in (inside, str(link / "cutover-report.json")):
        done = run_wrapper(["--input", path, "--report", report, "--dry-run", *target_args()],
                           cwd=tmp_path)
        assert done.returncode == 1, done.stdout + done.stderr
        assert "refused: path" in done.stdout
        assert not os.path.exists(inside)
    inside_input = os.path.join(BACKEND, "cutover-input.json")
    done = run_wrapper(["--input", inside_input, "--report", str(tmp_path / "r.json"),
                        "--dry-run", *target_args()], cwd=tmp_path)
    assert "refused: path" in done.stdout


def test_a_relative_path_is_resolved_before_the_move_to_the_temp_directory(tmp_path, owner):
    """Run from inside the repo, a relative output path is refused as inside it: the
    path was resolved against the original directory, not the empty temp directory."""
    path = write_input(tmp_path, fixture(), owner)
    done = run_wrapper(["--input", path, "--report", "relative-report.json", "--dry-run",
                        *target_args()], cwd=BACKEND)
    assert done.returncode == 1
    assert "refused: path" in done.stdout and "APP_IMPORTED=False" in done.stdout
    assert not os.path.exists(os.path.join(BACKEND, "relative-report.json"))


def test_outputs_are_created_new_at_mode_0600(tmp_path):
    from app.cutover_load.bootstrap import Refused
    from app.cutover_load.outputs import create_private, replace_private

    path = str(tmp_path / "out.json")
    create_private(path, b"{}")
    assert mode_of(path) == 0o600
    with pytest.raises(Refused):
        create_private(path, b"{}")  # never overwrites
    replace_private(path, b'{"a": 1}')
    assert mode_of(path) == 0o600 and json.loads(open(path).read()) == {"a": 1}


def test_an_expect_host_mismatch_is_refused_before_connecting(tmp_path, owner):
    path = write_input(tmp_path, fixture(), owner)
    other = "localhost" if TARGET["host"] != "localhost" else "127.0.0.1"
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args(host=other)], cwd=tmp_path)
    assert done.returncode == 1
    assert "refused: expect_host" in done.stdout
    assert "observed:" not in done.stdout and "APP_IMPORTED=False" in done.stdout


@pytest.mark.parametrize("query,env", [("host=db.invalid", {}), ("hostaddr=192.0.2.1", {}),
                                       ("", {"PGHOSTADDR": "192.0.2.1"}),
                                       ("", {"PGTZ": "Asia/Manila"}),
                                       ("options=-c%20search_path%3Dx", {}),
                                       ("sslmode=prefer&sslmode=disable", {})])
def test_target_overrides_are_refused_before_importing_the_app(query, env, tmp_path, owner):
    path = write_input(tmp_path, fixture(), owner)
    url = TARGET["url"] + (f"?{query}" if query else "")
    done = run_wrapper(["--input", path, "--report", str(tmp_path / "r.json"), "--dry-run",
                        *target_args()], cwd=tmp_path, url=url, extra_env=env)
    assert done.returncode == 1
    assert "refused:" in done.stdout and "observed:" not in done.stdout
    assert "APP_IMPORTED=False" in done.stdout
    assert "pw@" not in done.stdout + done.stderr  # never the password


