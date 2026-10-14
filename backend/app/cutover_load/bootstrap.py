"""Connection-target rules for the cutover load (plan v3, sections 1.12 and 2.4).

Imports nothing from the app, so the wrapper runs it before ``app`` is
imported: the URL is refused before any import or connection, and the
target is verified right after connecting, before any write.

- The URL comes only from the ``DATABASE_URL`` environment variable.
- ``validate_url``: the driver is ``postgresql`` or ``postgresql+psycopg2``;
  there is one non-empty host with no comma; host and database equal
  ``--expect-host`` and ``--expect-db``; every query key is in
  ``ALLOWED_QUERY_KEYS`` with a single value (a ``host``, ``hostaddr``,
  ``port``, ``dbname``, ``service`` or ``options`` key would override the
  authority in libpq).
- ``check_pg_environment``: none of ``PG_TARGET_ENV`` is set (libpq reads
  them for any parameter the URL leaves out, and ``PGTZ`` sets the session
  time zone).
- ``verify_target``: ``current_database()`` equals ``--expect-db`` and
  ``host(inet_server_addr())`` equals ``--expect-server-addr`` when given; a
  null address (a Unix socket) is refused.

Messages carry only the host, the database name and the server address,
never the password or a raw driver error (``error_class``).
"""

import os
from typing import Mapping, Optional, Tuple

ALLOWED_DRIVERS = frozenset({"postgresql", "postgresql+psycopg2"})
ALLOWED_QUERY_KEYS = frozenset({"sslmode", "sslrootcert", "connect_timeout", "application_name"})
# PGTZ too: libpq sends it as the session TimeZone, which decides every stored and
# read date (the columns are timestamptz); the load runs in the server's default.
PG_TARGET_ENV = ("PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE",
                 "PGTZ")

# One cutover run at a time: the load and the reset take
# pg_try_advisory_xact_lock on this key; the cutover check takes the shared form.
# It must equal CUTOVER_LOCK_KEY in app/cutover_check/bootstrap.py (not imported:
# the two packages stay independent).
CUTOVER_LOCK_KEY = 2_024_020_204


class Refused(Exception):
    """A refusal with a short check name and a message that holds no secret."""

    def __init__(self, check: str, message: str):
        super().__init__(f"{check}: {message}")
        self.check = check
        self.message = message


def error_class(exc: BaseException) -> str:
    """A raw error reduced to its class name, so no driver text (or password) is printed."""
    return type(exc).__name__


def read_url(environ: Mapping[str, str] = os.environ) -> str:
    url = environ.get("DATABASE_URL", "")
    if not url:
        raise Refused("url", "DATABASE_URL is not set in the environment")
    return url


def check_pg_environment(environ: Mapping[str, str] = os.environ) -> None:
    present = [name for name in PG_TARGET_ENV if environ.get(name)]
    if present:
        raise Refused("pg_environment",
                      f"unset {', '.join(present)}: libpq would read it as part of the target")


def validate_url(raw: str, *, expect_host: str, expect_db: str):
    """The parsed URL, or ``Refused`` (see the module docstring)."""
    from sqlalchemy.engine import make_url

    try:
        url = make_url(raw)
    except Exception as exc:  # the parser's message repeats the URL, password included
        raise Refused("url", f"DATABASE_URL does not parse ({error_class(exc)})") from None
    if url.drivername not in ALLOWED_DRIVERS:
        raise Refused("url", f"driver {url.drivername!r} is not postgresql or postgresql+psycopg2")
    if not url.host or "," in url.host:
        raise Refused("url", "the URL needs exactly one host")
    for key, value in url.query.items():
        if key not in ALLOWED_QUERY_KEYS:
            raise Refused("url", f"query key {key!r} is not allowed")
        if isinstance(value, tuple):
            raise Refused("url", f"query key {key!r} is repeated")
    if url.host != expect_host:
        raise Refused("expect_host", f"the URL's host is {url.host!r}, not {expect_host!r}")
    if url.database != expect_db:
        raise Refused("expect_db", f"the URL's database is {url.database!r}, not {expect_db!r}")
    return url


def target_line(url) -> str:
    return f"target: host={url.host} db={url.database}"


def observe_target(conn) -> Tuple[str, Optional[str]]:
    """``(current_database(), host(inet_server_addr()))`` on ``conn``."""
    from sqlalchemy import text

    database, address = conn.execute(
        text("SELECT current_database(), host(inet_server_addr())")).one()
    return database, address


def check_target(observed: Tuple[str, Optional[str]], *, expect_db: str,
                 expect_server_addr: Optional[str]) -> Tuple[str, str]:
    """The observed target, refused unless it matches the flags (see the module docstring)."""
    database, address = observed
    if address is None:
        raise Refused("server_addr", "connected over a Unix socket; connect over TCP")
    if database != expect_db:
        raise Refused("expect_db", f"connected to database {database!r}, not {expect_db!r}")
    if expect_server_addr is not None and address != expect_server_addr:
        raise Refused("expect_server_addr",
                      f"the server address is {address}, not {expect_server_addr}")
    return database, address


def verify_target(conn, *, expect_db: str, expect_server_addr: Optional[str]) -> Tuple[str, str]:
    """``observe_target`` then ``check_target``."""
    return check_target(observe_target(conn), expect_db=expect_db,
                        expect_server_addr=expect_server_addr)
