from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.core.config import settings

# Every session on UTC (STU-315): the date columns are timestamptz, so a naive
# value is stored, and an aware one read back, in the session's zone. Pinned, a
# naive value is stored as its UTC components whatever the server's default.
UTC_SESSION_OPTIONS = "-c timezone=UTC"


def make_engine(url):
    """The application's engine, its sessions pinned to UTC."""
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=300,
        connect_args={"options": UTC_SESSION_OPTIONS},
    )


engine = make_engine(settings.DATABASE_URL)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

# Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
