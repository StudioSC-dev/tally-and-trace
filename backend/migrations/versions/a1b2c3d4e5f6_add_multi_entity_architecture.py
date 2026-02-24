"""add multi-entity architecture

Revision ID: a1b2c3d4e5f6
Revises: e6f1c3b9b1c5
Create Date: 2026-02-23 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM

# revision identifiers, used by Alembic.
revision = 'a1b2c3d4e5f6'
down_revision = 'e6f1c3b9b1c5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Define enum types (PostgreSQL-specific ENUM gives us proper create_type control)
    entitytype = ENUM('personal', 'business', name='entitytype', create_type=False)
    memberrole = ENUM('owner', 'member', name='memberrole', create_type=False)
    currencytype = ENUM('PHP', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SGD', name='currencytype', create_type=False)
    wishlistpriority = ENUM('low', 'medium', 'high', 'critical', name='wishlistpriority', create_type=False)

    # Create only the NEW enum types (currencytype already exists from earlier migration)
    entitytype.create(op.get_bind(), checkfirst=True)
    memberrole.create(op.get_bind(), checkfirst=True)
    wishlistpriority.create(op.get_bind(), checkfirst=True)

    # 2. Create entities table
    op.create_table(
        'entities',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(150), nullable=False),
        sa.Column('entity_type', entitytype, nullable=False, server_default='personal'),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('default_currency', sa.String(10), nullable=True, server_default='PHP'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_entities_id', 'entities', ['id'])
    op.create_index('ix_entities_name', 'entities', ['name'])

    # 3. Create entity_memberships table
    op.create_table(
        'entity_memberships',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('entity_id', sa.Integer(), nullable=False),
        sa.Column('role', memberrole, nullable=False, server_default='member'),
        sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['entity_id'], ['entities.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_entity_memberships_id', 'entity_memberships', ['id'])

    # 4. Create wishlist_items table
    op.create_table(
        'wishlist_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('entity_id', sa.Integer(), nullable=True),
        sa.Column('name', sa.String(200), nullable=False),
        sa.Column('estimated_cost', sa.Float(), nullable=False),
        sa.Column('currency', currencytype, nullable=False, server_default='PHP'),
        sa.Column('priority', wishlistpriority, nullable=False, server_default='medium'),
        sa.Column('category_id', sa.Integer(), nullable=True),
        sa.Column('url', sa.String(500), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('target_date', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_purchased', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('purchased_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['entity_id'], ['entities.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['category_id'], ['categories.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_wishlist_items_id', 'wishlist_items', ['id'])

    # 5. Add entity_id columns to existing tables (nullable, no default)
    op.add_column('accounts', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_accounts_entity_id', 'accounts', 'entities', ['entity_id'], ['id'])
    op.create_index('ix_accounts_entity_id', 'accounts', ['entity_id'])

    op.add_column('transactions', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_transactions_entity_id', 'transactions', 'entities', ['entity_id'], ['id'])
    op.create_index('ix_transactions_entity_id', 'transactions', ['entity_id'])

    op.add_column('categories', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_categories_entity_id', 'categories', 'entities', ['entity_id'], ['id'])
    op.create_index('ix_categories_entity_id', 'categories', ['entity_id'])

    op.add_column('allocations', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_allocations_entity_id', 'allocations', 'entities', ['entity_id'], ['id'])
    op.create_index('ix_allocations_entity_id', 'allocations', ['entity_id'])

    op.add_column('budget_entries', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key('fk_budget_entries_entity_id', 'budget_entries', 'entities', ['entity_id'], ['id'])
    op.create_index('ix_budget_entries_entity_id', 'budget_entries', ['entity_id'])

    # 6. Backfill: create a default "Personal" entity for each existing user
    #    and backfill all their records.
    op.execute("""
        WITH inserted_entities AS (
            INSERT INTO entities (name, entity_type, description, default_currency, is_active, created_at)
            SELECT
                first_name || ' ' || last_name || '''s Personal',
                'personal',
                'Auto-created default entity',
                COALESCE(default_currency::text, 'PHP'),
                true,
                now()
            FROM users
            RETURNING id, (
                SELECT id FROM users u
                WHERE first_name || ' ' || last_name || '''s Personal' = (
                    SELECT first_name || ' ' || last_name || '''s Personal' FROM users WHERE id = u.id
                )
                LIMIT 1
            ) AS user_id
        )
        SELECT 1
    """)

    # Simpler backfill: insert one entity per user and capture ids
    op.execute("""
        INSERT INTO entity_memberships (user_id, entity_id, role, joined_at)
        SELECT u.id, e.id, 'owner', now()
        FROM users u
        JOIN entities e ON e.name = u.first_name || ' ' || u.last_name || '''s Personal'
        WHERE NOT EXISTS (
            SELECT 1 FROM entity_memberships em WHERE em.user_id = u.id
        )
    """)

    # Set entity_id on all existing financial records to the user's first entity
    for table in ('accounts', 'transactions', 'categories', 'allocations', 'budget_entries'):
        op.execute(f"""
            UPDATE {table} t
            SET entity_id = (
                SELECT em.entity_id
                FROM entity_memberships em
                WHERE em.user_id = t.user_id
                ORDER BY em.joined_at
                LIMIT 1
            )
            WHERE t.entity_id IS NULL
        """)


def downgrade() -> None:
    # Drop entity_id columns
    for table in ('budget_entries', 'allocations', 'categories', 'transactions', 'accounts'):
        op.drop_index(f'ix_{table}_entity_id', table_name=table)
        op.drop_constraint(f'fk_{table}_entity_id', table, type_='foreignkey')
        op.drop_column(table, 'entity_id')

    op.drop_index('ix_wishlist_items_id', table_name='wishlist_items')
    op.drop_table('wishlist_items')

    op.drop_index('ix_entity_memberships_id', table_name='entity_memberships')
    op.drop_table('entity_memberships')

    op.drop_index('ix_entities_name', table_name='entities')
    op.drop_index('ix_entities_id', table_name='entities')
    op.drop_table('entities')

    op.execute("DROP TYPE IF EXISTS entitytype")
    op.execute("DROP TYPE IF EXISTS memberrole")
    op.execute("DROP TYPE IF EXISTS wishlistpriority")
