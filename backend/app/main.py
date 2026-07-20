from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.core.config import settings
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
    demo data (a no-op if the DB is already populated).

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
@app.api_route("/health", methods=["GET", "HEAD"])
async def health_check():
    return {"status": "healthy"}
