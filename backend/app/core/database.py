from sqlalchemy import create_engine, event
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from app.core.config import settings

# Every session on UTC (STU-315): the date columns are timestamptz, so a naive
# value is stored, and an aware one read back, in the session's zone. Pinned, a
# naive value is stored as its UTC components whatever the server's default.
# The cutover engines pass this startup option (they connect directly).
UTC_SESSION_OPTIONS = "-c timezone=UTC"


def pin_utc(conn) -> None:
    """Pin the transaction just begun to UTC (the app engine's ``begin`` listener).

    Per transaction, not per connection: the app connects through the Supabase
    pooler, which drops or refuses a ``timezone`` startup parameter and hands a
    connection to another client between transactions. ``SET LOCAL`` lasts to
    the transaction's end. It fires on every ORM session's autobegin and on
    ``engine.begin()``/``connect()``; a connection in AUTOCOMMIT runs no
    transaction, so nothing pins it (the app never uses one).
    """
    conn.exec_driver_sql("SET LOCAL TIME ZONE 'UTC'")


def make_engine(url):
    """The application's engine, each transaction pinned to UTC (``pin_utc``)."""
    engine = create_engine(url, pool_pre_ping=True, pool_recycle=300)
    event.listen(engine, "begin", pin_utc)
    return engine


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
