"""Hermetic bootstrap, connection-target pinning and output rules for the cutover check.

Everything here runs before any other ``app`` module is imported, so it uses the
standard library and ``sqlalchemy.engine.url`` only. The cutover load keeps its own
copy of these rules; this package never imports it.

Order (see ``scripts/cutover_check.py``):

1. every path argument is made absolute with ``os.path.realpath``;
2. the process moves into an empty temporary directory, so no ``.env`` loads;
3. ``DATABASE_URL`` (the environment only) is validated against ``--expect-host``
   and ``--expect-db``, with no libpq override left open;
4. only then is the rest of the app imported and a connection made, after which
   ``verify_target`` pins the database name and server address.
"""

from __future__ import annotations

import ipaddress
import os
import sys
import tempfile
from typing import Mapping, Optional

from sqlalchemy.engine.url import URL, make_url

ALLOWED_DRIVERS = ("postgresql", "postgresql+psycopg2")
ALLOWED_QUERY_KEYS = frozenset({"sslmode", "sslrootcert", "connect_timeout", "application_name"})
# libpq reads these for any parameter the URL leaves out (PGHOSTADDR wins over host);
# PGTZ sets the server session's TimeZone, which the timestamptz dates are read in.
FORBIDDEN_ENV = ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE",
                 "PGTZ")

# The advisory lock key shared by the cutover load (exclusive) and this check (shared).
CUTOVER_LOCK_KEY = 2_024_020_204


class BootstrapError(Exception):
    """A refusal before any check runs. Its message never carries a password."""


def backend_dir() -> str:
    """``backend/``: the directory holding the ``app`` package."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def repo_root(start: Optional[str] = None) -> str:
    """The git work tree holding this file: the nearest parent with a ``.git`` entry."""
    here = os.path.dirname(os.path.realpath(start or __file__))
    while True:
        if os.path.exists(os.path.join(here, ".git")):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            raise BootstrapError("could not find the repository root")
        here = parent


def absolute(path: str, cwd: Optional[str] = None) -> str:
    """``path`` resolved (symlinks included) against ``cwd`` (default: the current one)."""
    base = cwd or os.getcwd()
    return os.path.realpath(os.path.join(base, os.path.expanduser(path)))


def require_outside_repo(path: str, label: str, root: Optional[str] = None) -> str:
    """Refuse a path that resolves inside the repository; returns its real path."""
    real = os.path.realpath(path)
    top = os.path.realpath(root or repo_root())
    if real == top or real.startswith(top + os.sep):
        raise BootstrapError(f"{label} must live outside the repository")
    return real


def hermetic() -> str:
    """Move into a fresh empty directory and put ``backend/`` first on ``sys.path``."""
    empty = tempfile.mkdtemp(prefix="cutover-check-")
    os.chdir(empty)
    backend = backend_dir()
    if not sys.path or sys.path[0] != backend:
        sys.path.insert(0, backend)
    return empty


def validate_url(raw: Optional[str], expect_host: str, expect_db: str,
                 environ: Mapping[str, str]) -> URL:
    """The parsed ``DATABASE_URL``, or a refusal naming the first rule it breaks."""
    for name in FORBIDDEN_ENV:
        if environ.get(name):
            raise BootstrapError(f"{name} is set; unset it so the URL is the whole target")
    if not raw:
        raise BootstrapError("DATABASE_URL is not set")
    try:
        url = make_url(raw)
    except Exception as exc:  # the message may echo the URL
        raise BootstrapError(f"DATABASE_URL could not be parsed ({type(exc).__name__})") from None
    if url.drivername not in ALLOWED_DRIVERS:
        raise BootstrapError("DATABASE_URL must use the postgresql or postgresql+psycopg2 driver")
    host = url.host or ""
    if not host or "," in host:
        raise BootstrapError("DATABASE_URL must name exactly one host")
    for key, value in url.query.items():
        if key not in ALLOWED_QUERY_KEYS:
            raise BootstrapError(f"DATABASE_URL query key '{key}' is not allowed")
        if isinstance(value, tuple):
            raise BootstrapError(f"DATABASE_URL query key '{key}' is repeated")
    if host != expect_host:
        raise BootstrapError(f"DATABASE_URL host '{host}' is not --expect-host '{expect_host}'")
    if (url.database or "") != expect_db:
        raise BootstrapError(
            f"DATABASE_URL database '{url.database or ''}' is not --expect-db '{expect_db}'")
    return url


def target_line(url: URL) -> str:
    """The only connection details ever printed before connecting."""
    return f"target: host={url.host} db={url.database}"


def observe_target(conn) -> tuple:
    """``(database, server address)`` as the server reports them."""
    from sqlalchemy import text

    row = conn.execute(text("SELECT current_database(), host(inet_server_addr())")).one()
    return row[0], row[1]


def verify_target(conn, expect_db: str, expect_server_addr: str) -> tuple:
    """Refuse unless the connected database and server address are the expected ones."""
    database, addr = observe_target(conn)
    if database != expect_db:
        raise BootstrapError(f"connected database '{database}' is not --expect-db '{expect_db}'")
    if addr is None:
        raise BootstrapError("the server address is null (a Unix socket); connect over TCP")
    try:
        same = ipaddress.ip_address(addr) == ipaddress.ip_address(expect_server_addr)
    except ValueError:
        same = False
    if not same:
        raise BootstrapError(
            f"server address {addr} is not --expect-server-addr {expect_server_addr}")
    return database, addr


def create_private(path: str, data: str) -> None:
    """Write a new file at mode 0600; refuses to replace an existing one."""
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(data)


def error_class(exc: BaseException) -> str:
    """A driver error as its class name only: raw messages may carry the DSN."""
    orig = getattr(exc, "orig", None)
    return type(orig).__name__ if orig is not None else type(exc).__name__
