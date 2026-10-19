"""Keeps the backend tests on a local throwaway database.

The tests create and delete real rows through the application's own engine, and the
developer's ``backend/.env`` points at production. This module is imported by
``conftest.py`` before anything from ``app`` or ``sqlalchemy``, so it must stay
stdlib-only: no driver may be loaded until the target has been vetted.
"""
import os
import re
from typing import Callable, NoReturn, Optional
from urllib.parse import urlsplit

# libpq reads these when the URL leaves the matching part out (or, for the service
# and sysconf ones, replaces it), so any of them can route a "local" URL elsewhere.
LIBPQ_ROUTING_VARS = (
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGSYSCONFDIR",
    "PGOPTIONS",
)
ALLOWED_SCHEMES = ("postgresql", "postgresql+psycopg2", "postgresql+psycopg")
ALLOWED_HOSTS = ("127.0.0.1", "localhost", "::1")
_THROWAWAY_NAME = re.compile(r"^tt_test_[a-z0-9_]+$")


def check_environment(environ=None) -> Optional[str]:
    """The reason to refuse (a libpq routing variable is set), or None."""
    environ = os.environ if environ is None else environ
    for name in LIBPQ_ROUTING_VARS:
        if environ.get(name):
            return f"unset {name} (libpq would route the connection)"
    return None


def _database_name_allowed(name: str) -> bool:
    return name == "tally_trace_test" or bool(_THROWAWAY_NAME.match(name))


def check_test_database_url(url: str) -> Optional[str]:
    """The reason to refuse this DATABASE_URL, or None. Never echoes the password."""
    if not url:
        return "DATABASE_URL is not set"
    try:
        parts = urlsplit(url)
        parts.port  # raises ValueError on a malformed port
    except ValueError:
        return "DATABASE_URL is not a valid URL"
    if parts.scheme not in ALLOWED_SCHEMES:
        return f"scheme {parts.scheme!r} is not one of {', '.join(ALLOWED_SCHEMES)}"
    if parts.query:
        return "the URL has a query string, which can override the host or database"
    if parts.fragment:
        return "the URL has a fragment"
    # Judge the whole netloc, as frontend/e2e/_local_stack.cjs does: SQLAlchemy
    # splits it at the first "@" and libpq reads a "," as a host list, so a second
    # unescaped "@" or a "," anywhere (the password included) can name another
    # host than the one urlsplit reports. An escaped "%40" is fine.
    if parts.netloc.count("@") > 1:
        return "the URL has more than one unescaped @"
    if "," in parts.netloc:
        return "the URL names more than one host"
    if parts.hostname not in ALLOWED_HOSTS:
        return f"host {parts.hostname!r} is not local ({', '.join(ALLOWED_HOSTS)})"
    name = parts.path[1:] if parts.path.startswith("/") else parts.path
    if not _database_name_allowed(name):
        return (
            f"database {name!r} is not a throwaway test database "
            "(tally_trace_test or tt_test_<name>)"
        )
    return None


def check_engine(url, expected_url: str) -> Optional[str]:
    """The reason to refuse the application's engine URL (a SQLAlchemy URL), or None."""
    expected = urlsplit(expected_url)
    if url.query:
        return "the engine URL carries a query string"
    if url.host != expected.hostname:
        return "the engine host differs from the guarded DATABASE_URL"
    if url.database != expected.path[1:]:
        return "the engine database differs from the guarded DATABASE_URL"
    return None


def _exit(message: str) -> NoReturn:
    import pytest

    pytest.exit(message, returncode=2)


def guard(exit_with: Callable[[str], NoReturn] = _exit) -> None:
    """Run the pre-import checks. Call before importing anything from ``app``."""
    reason = check_environment()
    if reason:
        exit_with(f"refusing: {reason}")
    os.environ["TT_DISABLE_DOTENV"] = "1"
    reason = check_test_database_url(os.environ.get("DATABASE_URL", ""))
    if reason:
        exit_with(f"refusing DATABASE_URL: {reason}")


def require_reachable(engine, exit_with: Callable[[str], NoReturn] = _exit) -> None:
    """With REQUIRE_DB=1, an unreachable database ends the run instead of skipping tests."""
    if os.environ.get("REQUIRE_DB") != "1":
        return
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")
    except Exception:
        exit_with("REQUIRE_DB=1 but the test database is unreachable")
