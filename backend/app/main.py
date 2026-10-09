from fastapi import FastAPI, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from app.core.config import settings
from app.core.database import SessionLocal
from app.routers import api_router
from app.core.seed import seed_database
from app.core.observability import init_sentry
from contextlib import asynccontextmanager
import os
import logging
import sys

# Configure logging - must be done before uvicorn starts
# Use force=True to override any existing configuration
logging.basicConfig(
    level=logging.INFO,  # Always use INFO so we can see our logs
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
    force=True,  # Override uvicorn's default logging
    handlers=[
        logging.StreamHandler(sys.stdout)  # Explicitly use stdout
    ]
)

# Set specific loggers to INFO level for better debugging
logging.getLogger("app").setLevel(logging.INFO)
logging.getLogger("app.services.email").setLevel(logging.INFO)
logging.getLogger("app.routers.auth").setLevel(logging.INFO)
logging.getLogger("app.routers").setLevel(logging.INFO)

# Reduce noise from uvicorn access logs
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)
logger.info(f"Starting {settings.PROJECT_NAME} v{settings.VERSION} in {settings.ENVIRONMENT} mode")
logger.info("Logging configured successfully.")

# Must run before the FastAPI app is constructed so the ASGI middleware Sentry
# installs wraps every route, including anything added below.
init_sentry()


def _run_startup():
    """Seed initial data on startup.

    The database SCHEMA is owned by Alembic. Migrations run at build time in
    production via render.yaml (`alembic upgrade head`), and must be run locally
    with `alembic upgrade head` before starting the app. This hook only seeds
    the demo user (a no-op unless the demo shape version changed; see
    app/core/seed.py).

    The old raw-SQL DDL block that used to live here was removed: it duplicated
    the migrations and was proven incomplete (it never created
    `users.onboarding_completed`, added only by migration 8be3628d). Alembic is
    the single source of truth for schema — see HANDOVER.md.
    """
    logger.info("Application startup - seeding database (schema managed by Alembic)")
    seed_database()
    logger.info("Database seeding completed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup seeding (replaces the deprecated on_event hook)."""
    _run_startup()
    yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description=settings.DESCRIPTION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    lifespan=lifespan,
)

# Set up CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files for uploads
if os.path.exists(settings.UPLOAD_DIR):
    app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")

# Include API router
app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/")
async def root():
    return {"message": "Welcome to Tally & Trace API"}


# HEAD is explicit: FastAPI's APIRoute, unlike Starlette's Route, does not add
# HEAD alongside GET, and uptime monitors probe with HEAD by default.
#
# The `SELECT 1` is deliberate and load-bearing beyond liveness: Supabase pauses
# a free-tier project after ~7 days with no activity, and this endpoint is the
# only thing that runs on a schedule. Without a query it reported "healthy"
# while generating zero database activity, so Render stayed warm and Supabase
# could pause underneath it — two clocks, only one being wound.
#
# `def`, not `async def`: SQLAlchemy here is sync, so an `async` handler would
# block the event loop for the round-trip. FastAPI runs sync handlers in a
# threadpool.
#
# The session is opened inline rather than via `Depends(get_db)` because a
# dependency that cannot connect raises before the handler runs, which would
# surface as an opaque 500 instead of the explicit signal below.
@app.api_route("/health", methods=["GET", "HEAD"])
def health_check(response: Response):
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
    except Exception:
        # 503 so a HEAD probe — which discards the body — still carries the
        # signal. Safe today because render.yaml sets no `healthCheckPath`, so
        # nothing restarts the container on this status; it reaches the uptime
        # monitor only. Adding a health check to render.yaml later would turn a
        # database outage into a restart loop, which would not fix anything.
        logger.exception("Health check database probe failed")
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "degraded", "database": "unavailable"}

    return {"status": "healthy", "database": "ok"}
