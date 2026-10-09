"""drop entity schema

Contract step for STU-230 (STU-229 removed every use of entities from the app).

Upgrade drops ``entity_id`` (its foreign key and, where one exists, its index)
from ``accounts``, ``transactions``, ``categories``, ``allocations``,
``budget_entries`` and ``wishlist_items``; then ``entity_memberships``, then
``entities``; then the enum types ``entitytype`` and ``memberrole``.
``wishlist_items`` and ``wishlistpriority`` stay.

Downgrade is schema only: it recreates the types, both tables, the six
nullable columns, their foreign keys and the five indexes, as they were at
e5b7c9d1f3a6. The data that lived in them is not restored.

Revision ID: 7b3d9f1a5c82
Revises: e5b7c9d1f3a6
Create Date: 2026-10-09 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ENUM

# revision identifiers, used by Alembic.
revision = '7b3d9f1a5c82'
down_revision = 'e5b7c9d1f3a6'
branch_labels = None
depends_on = None

# Tables whose entity_id has the fk_<table>_entity_id foreign key (no ON DELETE)
# and the ix_<table>_entity_id index.
INDEXED_TABLES = ('accounts', 'transactions', 'categories', 'allocations', 'budget_entries')


def upgrade() -> None:
    for table in INDEXED_TABLES:
        op.drop_index(f'ix_{table}_entity_id', table_name=table)
        op.drop_constraint(f'fk_{table}_entity_id', table, type_='foreignkey')
        op.drop_column(table, 'entity_id')

    # wishlist_items: ON DELETE SET NULL foreign key, no index.
    op.drop_constraint('wishlist_items_entity_id_fkey', 'wishlist_items', type_='foreignkey')
    op.drop_column('wishlist_items', 'entity_id')

    op.drop_index('ix_entity_memberships_id', table_name='entity_memberships')
    op.drop_table('entity_memberships')

    op.drop_index('ix_entities_name', table_name='entities')
    op.drop_index('ix_entities_id', table_name='entities')
    op.drop_table('entities')

    op.execute("DROP TYPE entitytype")
    op.execute("DROP TYPE memberrole")


def downgrade() -> None:
    entitytype = ENUM('personal', 'business', name='entitytype', create_type=False)
    memberrole = ENUM('owner', 'member', name='memberrole', create_type=False)
    entitytype.create(op.get_bind(), checkfirst=True)
    memberrole.create(op.get_bind(), checkfirst=True)

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

    for table in INDEXED_TABLES:
        op.add_column(table, sa.Column('entity_id', sa.Integer(), nullable=True))
        op.create_foreign_key(f'fk_{table}_entity_id', table, 'entities', ['entity_id'], ['id'])
        op.create_index(f'ix_{table}_entity_id', table, ['entity_id'])

    op.add_column('wishlist_items', sa.Column('entity_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'wishlist_items_entity_id_fkey', 'wishlist_items', 'entities',
        ['entity_id'], ['id'], ondelete='SET NULL',
    )
