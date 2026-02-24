from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.core.config import settings
from app.routers import api_router
from app.core.database import engine
from app.core.seed import seed_database
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

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description=settings.DESCRIPTION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json"
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

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

# Database initialization
@app.on_event("startup")
async def startup_event():
    """Initialize database tables and seed data on startup"""
    logger.info("Application startup event triggered - logging is active")
    from sqlalchemy import text
    
    # Create tables using synchronous engine
    with engine.begin() as conn:
        # Create enum types first
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE accounttype AS ENUM ('cash', 'e_wallet', 'savings', 'checking', 'credit');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE transactiontype AS ENUM ('debit', 'credit', 'transfer');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE allocationtype AS ENUM ('savings', 'budget', 'goal');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE budgetentrytype AS ENUM ('income', 'expense');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE recurrencefrequency AS ENUM ('monthly', 'quarterly', 'semi_annual', 'annual');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE currencytype AS ENUM ('PHP', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SGD');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))

        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE entitytype AS ENUM ('personal', 'business');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))

        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE memberrole AS ENUM ('owner', 'member');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))

        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE wishlistpriority AS ENUM ('low', 'medium', 'high', 'critical');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                is_verified BOOLEAN DEFAULT FALSE,
                default_currency currencytype DEFAULT 'PHP',
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP WITH TIME ZONE
            )
        """))
        
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                name VARCHAR(100) NOT NULL,
                account_type accounttype NOT NULL,
                balance DECIMAL(15,2) DEFAULT 0.0 NOT NULL,
                description TEXT,
                credit_limit DECIMAL(15,2),
                due_date INTEGER,
                billing_cycle_start INTEGER,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))
        
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                name VARCHAR(100) NOT NULL,
                description TEXT,
                color VARCHAR(7),
                is_expense BOOLEAN DEFAULT TRUE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))
        
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS allocations (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                account_id INTEGER NOT NULL REFERENCES accounts(id),
                name VARCHAR(100) NOT NULL,
                allocation_type allocationtype NOT NULL,
                description TEXT,
                target_amount DECIMAL(15,2),
                current_amount DECIMAL(15,2) DEFAULT 0.0 NOT NULL,
                monthly_target DECIMAL(15,2),
                currency currencytype DEFAULT 'PHP',
                target_date TIMESTAMP WITH TIME ZONE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))
        
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS budget_entries (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                entry_type budgetentrytype NOT NULL,
                name VARCHAR(150) NOT NULL,
                description TEXT,
                amount DECIMAL(15,2) NOT NULL,
                currency currencytype DEFAULT 'PHP' NOT NULL,
                cadence recurrencefrequency NOT NULL DEFAULT 'monthly',
                next_occurrence TIMESTAMP WITH TIME ZONE NOT NULL,
                lead_time_days INTEGER NOT NULL DEFAULT 0,
                account_id INTEGER REFERENCES accounts(id),
                category_id INTEGER REFERENCES categories(id),
                allocation_id INTEGER REFERENCES allocations(id),
                is_autopay BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))
        
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                account_id INTEGER NOT NULL REFERENCES accounts(id),
                category_id INTEGER REFERENCES categories(id),
                allocation_id INTEGER REFERENCES allocations(id),
                amount DECIMAL(15,2) NOT NULL,
                currency currencytype DEFAULT 'PHP',
                description TEXT,
                transaction_type transactiontype NOT NULL,
                transaction_date TIMESTAMP WITH TIME ZONE NOT NULL,
                posting_date TIMESTAMP WITH TIME ZONE,
                receipt_url VARCHAR(500),
                invoice_url VARCHAR(500),
                is_reconciled BOOLEAN DEFAULT FALSE,
                is_recurring BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))
        
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS budget_entry_id INTEGER REFERENCES budget_entries(id)
        """))

        # ── Columns added after initial schema ──────────────────────────────
        # accounts
        conn.execute(text("""
            ALTER TABLE accounts
            ADD COLUMN IF NOT EXISTS currency currencytype NOT NULL DEFAULT 'PHP'
        """))
        conn.execute(text("""
            ALTER TABLE accounts
            ADD COLUMN IF NOT EXISTS days_until_due_date INTEGER DEFAULT 21
        """))

        # transactions – FX / multi-currency fields
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS projected_amount DECIMAL(15,2)
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS projected_currency currencytype
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS original_amount DECIMAL(15,2)
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS original_currency currencytype
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(15,6)
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS transfer_fee DECIMAL(15,2) NOT NULL DEFAULT 0
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS is_posted BOOLEAN NOT NULL DEFAULT TRUE
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS transfer_from_account_id INTEGER REFERENCES accounts(id)
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS transfer_to_account_id INTEGER REFERENCES accounts(id)
        """))
        conn.execute(text("""
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS recurrence_frequency recurrencefrequency
        """))

        # allocations – columns added after initial schema
        conn.execute(text("""
            DO $$ BEGIN
                CREATE TYPE allocationperiodfrequency AS ENUM ('daily', 'weekly', 'monthly', 'quarterly');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;
        """))
        conn.execute(text("""
            ALTER TABLE allocations
            ADD COLUMN IF NOT EXISTS currency currencytype NOT NULL DEFAULT 'PHP'
        """))
        conn.execute(text("""
            ALTER TABLE allocations
            ADD COLUMN IF NOT EXISTS configuration JSONB
        """))
        conn.execute(text("""
            ALTER TABLE allocations
            ADD COLUMN IF NOT EXISTS period_frequency allocationperiodfrequency
        """))
        conn.execute(text("""
            ALTER TABLE allocations
            ADD COLUMN IF NOT EXISTS period_start TIMESTAMP WITH TIME ZONE
        """))
        conn.execute(text("""
            ALTER TABLE allocations
            ADD COLUMN IF NOT EXISTS period_end TIMESTAMP WITH TIME ZONE
        """))

        # budget_entries – columns added after initial schema
        conn.execute(text("""
            ALTER TABLE budget_entries
            ADD COLUMN IF NOT EXISTS end_mode VARCHAR(20) NOT NULL DEFAULT 'indefinite'
        """))
        conn.execute(text("""
            ALTER TABLE budget_entries
            ADD COLUMN IF NOT EXISTS end_date TIMESTAMP WITH TIME ZONE
        """))
        conn.execute(text("""
            ALTER TABLE budget_entries
            ADD COLUMN IF NOT EXISTS max_occurrences INTEGER
        """))

        # Entity tables
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS entities (
                id SERIAL PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                entity_type entitytype NOT NULL DEFAULT 'personal',
                description TEXT,
                default_currency VARCHAR(10) DEFAULT 'PHP',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE
            )
        """))

        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS entity_memberships (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
                role memberrole NOT NULL DEFAULT 'member',
                joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        """))

        # Add entity_id columns to existing tables if they don't exist
        for tbl in ("accounts", "transactions", "categories", "allocations", "budget_entries"):
            conn.execute(text(f"""
                ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES entities(id)
            """))

        # Wishlist items table
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS wishlist_items (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
                name VARCHAR(200) NOT NULL,
                estimated_cost DECIMAL(15,2) NOT NULL,
                currency currencytype NOT NULL DEFAULT 'PHP',
                priority wishlistpriority NOT NULL DEFAULT 'medium',
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                url VARCHAR(500),
                notes TEXT,
                target_date TIMESTAMP WITH TIME ZONE,
                is_purchased BOOLEAN NOT NULL DEFAULT FALSE,
                purchased_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE
            )
        """))

    logger.info("Database tables initialized successfully!")
    print("Database tables initialized successfully!")
    
    # Always reset demo user's onboarding for testing
    from app.core.database import SessionLocal
    from app.models.user import User
    db = SessionLocal()
    try:
        demo_user = db.query(User).filter(User.email == "demo@example.com").first()
        if demo_user:
            demo_user.onboarding_completed = False
            db.commit()
            logger.info("Demo user onboarding status reset for testing")
    except Exception as e:
        logger.warning(f"Could not reset demo user onboarding: {e}")
    finally:
        db.close()
    
    # Seed database with initial data
    seed_database()
    logger.info("Database seeding completed")