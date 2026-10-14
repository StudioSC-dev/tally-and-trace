"""Where the cutover's files may live, and how they are written (plan v3, section 2.4).

Every input and output (the cutover input, the run record, the review
report, the cutover check's report) lives outside the git worktree: its
``realpath`` must not be under the ``realpath`` of the repo root, found by
walking up from this file to ``.git``. Files are created with ``O_EXCL`` at
mode 0600; a run record is updated by an atomic replace (a new 0600 file,
then ``os.replace``). Imports nothing from the app.
"""

import json
import os
from typing import Optional

from app.cutover_load.bootstrap import Refused


def repo_root(start: Optional[str] = None) -> str:
    """The nearest directory above ``start`` (default this file) holding ``.git``."""
    here = os.path.dirname(os.path.realpath(start or __file__))
    while True:
        if os.path.exists(os.path.join(here, ".git")):
            return here
        parent = os.path.dirname(here)
        if parent == here:
            raise Refused("repo_root", "no .git found above the cutover package")
        here = parent


def outside_repo(path: str, what: str) -> str:
    """``realpath(path)``, refused when it is inside the repo (symlinks resolved)."""
    real = os.path.realpath(path)
    root = os.path.realpath(repo_root())
    if os.path.commonpath([real, root]) == root:
        raise Refused("path", f"the {what} must live outside the repository")
    return real


def refuse_existing(*paths) -> None:
    """Refuse before any connection when an output already exists, so a later
    refusal can never leave a stale file (such as a ``prepared`` run record)."""
    for path in paths:
        if path and os.path.lexists(path):
            raise Refused("path", f"{os.path.basename(path)} already exists; choose a new path")


def create_private(path: str, data: bytes) -> None:
    """Create ``path`` (it must not exist) at mode 0600 and write ``data``."""
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise Refused("path", f"{os.path.basename(path)} already exists; choose a new path") \
            from None
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def replace_private(path: str, data: bytes) -> None:
    """Replace ``path`` atomically: a new 0600 file created with ``O_EXCL``, then ``os.replace``."""
    temp = f"{path}.{os.getpid()}.new"
    create_private(temp, data)
    os.replace(temp, path)


def to_json(document: dict) -> bytes:
    return (json.dumps(document, indent=2, sort_keys=True, default=str) + "\n").encode()


def read_json(path: str, what: str) -> dict:
    try:
        with open(path, "rb") as fh:
            document = json.loads(fh.read())
    except (OSError, ValueError) as exc:
        raise Refused("read", f"the {what} can't be read ({type(exc).__name__})") from None
    if not isinstance(document, dict):
        raise Refused("read", f"the {what} is not a JSON object")
    return document
