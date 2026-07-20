"""Sentry wiring for the API.

Deliberately a no-op when ``SENTRY_DSN`` is unset, so local dev and CI stay
offline and free-tier quota is only spent by the deployed service.

PII policy: this is a finance app, so ``send_default_pii`` stays off and
``_scrub_event`` strips anything that could carry balances, tokens, or account
numbers out of the payload before it leaves the process. Sentry gets the shape
of the failure (route, exception, stack), never the money.
"""

import logging
from typing import Any, Dict, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

# Headers/cookies that would leak a session if they reached Sentry.
_SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
}


def _scrub_event(event: Dict[str, Any], _hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Drop request bodies and auth headers before the event is sent."""
    request = event.get("request")
    if isinstance(request, dict):
        # Bodies carry transaction amounts, balances, and login credentials.
        request.pop("data", None)
        request.pop("cookies", None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            for name in list(headers):
                if name.lower() in _SENSITIVE_HEADERS:
                    headers[name] = "[Filtered]"
    return event


def init_sentry() -> bool:
    """Initialise Sentry if a DSN is configured. Returns whether it was enabled."""
    dsn = (settings.SENTRY_DSN or "").strip()
    if not dsn:
        logger.info("Sentry disabled (SENTRY_DSN not set)")
        return False

    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn,
        environment=settings.ENVIRONMENT,
        release=f"{settings.PROJECT_NAME}@{settings.VERSION}",
        # Never attach user emails, IPs, or request bodies automatically.
        send_default_pii=False,
        traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
        before_send=_scrub_event,
        before_send_transaction=_scrub_event,
    )
    logger.info(
        "Sentry enabled (environment=%s, traces_sample_rate=%s)",
        settings.ENVIRONMENT,
        settings.SENTRY_TRACES_SAMPLE_RATE,
    )
    return True
