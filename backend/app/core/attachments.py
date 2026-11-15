"""Receipt files: stored privately, served only through an authenticated route.

A receipt upload is saved under ``UPLOAD_DIR/receipts`` with a random name and
its row stores ``/uploads/receipts/<name>``. That path is never served as a
static file: ``GET /api/v1/transactions/{id}/receipt`` returns it only to a
caller who sees the transaction in ``full`` view, the same rule that decides who
is given ``receipt_url`` (see ``app/core/redaction.py``).

Responses show a stored ``/uploads/...`` path (rows from before this rule
included) as that route; any other stored value, such as an external link,
is returned unchanged. ``invoice_url`` has no upload: it is whatever the
creator entered, and is returned as stored.

A stored file is removed once nothing names it: after the commit that deletes
its transaction or replaces it with a new upload (``remove_stored_receipt``),
never before, so a rolled-back request keeps both the file and its row. Only a
file ``stored_receipt_path`` accepts is ever removed.
"""

import logging
import secrets
from pathlib import Path
from typing import Optional

from app.core.config import settings

STORED_PREFIX = "/uploads/"
RECEIPTS = "receipts"

logger = logging.getLogger(__name__)


def receipt_route(transaction_id: int) -> str:
    """The authenticated URL a receipt is fetched from."""
    return f"{settings.API_V1_STR}/transactions/{transaction_id}/receipt"


def public_receipt_url(transaction_id: int, stored: Optional[str]) -> Optional[str]:
    """``receipt_url`` as responses show it: a stored upload as its route."""
    if stored and stored.startswith(STORED_PREFIX):
        return receipt_route(transaction_id)
    return stored


def new_receipt_filename(transaction_id: int, extension: str) -> str:
    """A random, unguessable name, prefixed with the transaction it belongs to."""
    return f"receipt_{transaction_id}_{secrets.token_urlsafe(24)}.{extension}"


def stored_receipt_path(transaction_id: int, stored: Optional[str]) -> Optional[Path]:
    """The file a transaction's stored receipt names, or None.

    The path must resolve to a regular file directly inside
    ``UPLOAD_DIR/receipts`` (no traversal out of it, no symlink escape) whose
    name carries this transaction's id, so a creator who points their own row
    at another row's file is not served it.
    """
    if not stored or not stored.startswith(STORED_PREFIX):
        return None
    root = (Path(settings.UPLOAD_DIR) / RECEIPTS).resolve()
    try:
        path = (Path(settings.UPLOAD_DIR) / stored[len(STORED_PREFIX):]).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    if path.parent != root or not path.name.startswith(f"receipt_{transaction_id}_"):
        return None
    return path if path.is_file() else None


def remove_stored_receipt(transaction_id: int, stored: Optional[str]) -> None:
    """Delete the file a transaction's stored receipt named, once committed.

    Call only after the commit that dropped the reference. Anything
    ``stored_receipt_path`` refuses (an external link, a path outside
    ``UPLOAD_DIR/receipts``, a symlink, another transaction's file) is left
    alone. A file that cannot be removed is logged, not raised: the commit has
    already happened.
    """
    path = stored_receipt_path(transaction_id, stored)
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not remove a stored receipt file for transaction %s",
                       transaction_id)
