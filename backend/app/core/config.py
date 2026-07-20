from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List, Optional

# Placeholder values that are fine for local dev but must never reach production.
# Kept as module constants so the guard below can't drift from the field defaults.
_PLACEHOLDER_DATABASE_URL = "postgresql://user:password@localhost:5432/tally_trace"
_PLACEHOLDER_SECRET_KEY = "your-secret-key-here-change-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True)

    PROJECT_NAME: str = "Tally & Trace API"
    VERSION: str = "2.0.0"
    DESCRIPTION: str = "Multi-entity personal and business financial management"
    API_V1_STR: str = "/api/v1"
    
    # CORS - will be parsed from comma-separated string
    BACKEND_CORS_ORIGINS_STR: str = "http://localhost:3000,http://localhost:8000"
    
    # Database - PostgreSQL
    DATABASE_URL: str = _PLACEHOLDER_DATABASE_URL

    # Security
    SECRET_KEY: str = _PLACEHOLDER_SECRET_KEY
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # Refresh-token cookie (httpOnly, so JS/XSS can't read it).
    # Defaults suit local dev (host-only cookie over http). In production set:
    #   REFRESH_COOKIE_DOMAIN=.studiosc.dev   (shared across web + api subdomains)
    #   REFRESH_COOKIE_SECURE=true            (https only)
    # web and api are subdomains of one registrable domain, so they are same-site
    # and SameSite=lax cookies are still sent on the cross-subdomain XHR.
    REFRESH_COOKIE_NAME: str = "tt_refresh"
    REFRESH_COOKIE_DOMAIN: Optional[str] = None
    REFRESH_COOKIE_SECURE: bool = False
    REFRESH_COOKIE_SAMESITE: str = "lax"
    REFRESH_COOKIE_PATH: str = "/api/v1/auth"
    EMAIL_VERIFICATION_EXPIRE_HOURS: int = 48
    PASSWORD_RESET_EXPIRE_HOURS: int = 4
    FRONTEND_BASE_URL: str = "http://localhost:3000"
    RESEND_API_KEY: Optional[str] = None
    RESEND_FROM_EMAIL: Optional[str] = None

    # File Upload
    UPLOAD_DIR: str = "uploads"
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10MB
    ALLOWED_EXTENSIONS_STR: str = "jpg,jpeg,png,pdf,doc,docx"
    
    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # Observability (Sentry). Unset DSN = Sentry fully disabled, which is the
    # default for local dev and CI so neither spends free-tier quota.
    SENTRY_DSN: Optional[str] = None
    # Fraction of requests traced for performance metrics. Render's free tier
    # plus Sentry's free span quota means this stays low in production; 0
    # disables tracing without disabling error reporting.
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1

    @model_validator(mode="after")
    def _reject_placeholder_secrets_in_production(self) -> "Settings":
        """Fail fast when production boots with a placeholder default still in place.

        Without this, an unset DATABASE_URL silently falls back to localhost and the
        app dies with a bare `psycopg2 ... connection to server at "localhost" ...
        refused` — which reads like a database outage rather than missing config.
        That exact confusion cost a session during the Render region move (see
        HANDOVER Session 5, runbook step 2: `sync: false` vars are blank on a newly
        synced service, so the first build ran migrations against localhost).

        An unset SECRET_KEY is worse than confusing: the placeholder is public in
        this repo, so every JWT would be forgeable by anyone who read the source.
        """
        if self.ENVIRONMENT.strip().lower() != "production":
            return self

        placeholders = [
            name
            for name, value, placeholder in (
                ("DATABASE_URL", self.DATABASE_URL, _PLACEHOLDER_DATABASE_URL),
                ("SECRET_KEY", self.SECRET_KEY, _PLACEHOLDER_SECRET_KEY),
            )
            if value == placeholder
        ]
        if placeholders:
            raise ValueError(
                f"ENVIRONMENT=production but {', '.join(placeholders)} "
                f"{'is' if len(placeholders) == 1 else 'are'} still set to the "
                "placeholder default. Set real values in the service environment "
                "(Render: Settings → Environment) and redeploy."
            )
        return self

    @property
    def BACKEND_CORS_ORIGINS(self) -> List[str]:
        return [origin.strip() for origin in self.BACKEND_CORS_ORIGINS_STR.split(",")]
    
    @property
    def ALLOWED_EXTENSIONS(self) -> List[str]:
        return [ext.strip() for ext in self.ALLOWED_EXTENSIONS_STR.split(",")]
    
settings = Settings()
