from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List, Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.entity_context import (
    get_accessible_or_404,
    get_active_entity,
    scope_criterion,
    validate_entity_ownership,
)
from app.models.category import Category
from app.models.entity import Entity
from app.models.user import User
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate

router = APIRouter()

@router.get("/", response_model=List[CategoryResponse])
def get_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
    is_expense: Optional[bool] = Query(None, description="Filter by expense/income type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
):
    """Get all categories with optional filtering"""
    query = db.query(Category).filter(
        scope_criterion(Category, current_user.id, active_entity.id if active_entity else None)
    )

    if is_expense is not None:
        query = query.filter(Category.is_expense == is_expense)
    if is_active is not None:
        query = query.filter(Category.is_active == is_active)

    categories = query.all()
    return categories

@router.post("/", response_model=CategoryResponse)
def create_category(
    category: CategoryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    active_entity: Optional[Entity] = Depends(get_active_entity),
):
    """Create a new category"""
    # Uniqueness follows the same scope as visibility: within a shared entity two
    # members must not both create "Groceries", but a name used in one entity
    # mustn't block the same name in another.
    existing_category = db.query(Category).filter(
        Category.name == category.name,
        scope_criterion(Category, current_user.id, active_entity.id if active_entity else None),
    ).first()
    if existing_category:
        raise HTTPException(status_code=400, detail="Category with this name already exists")

    category_data = category.dict()
    if category_data.get("entity_id") is None and active_entity is not None:
        category_data["entity_id"] = active_entity.id
    else:
        validate_entity_ownership(db, current_user, category_data.get("entity_id"))

    db_category = Category(**category_data, user_id=current_user.id)
    db.add(db_category)
    db.commit()
    db.refresh(db_category)
    return db_category

@router.get("/{category_id}", response_model=CategoryResponse)
def get_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Get a specific category by ID"""
    return get_accessible_or_404(db, Category, category_id, current_user, "Category not found")

@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: int,
    category_update: CategoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an existing category"""
    db_category = get_accessible_or_404(db, Category, category_id, current_user, "Category not found")

    # Same scope as create: conflict against the category's own entity, not the editor's.
    if category_update.name and category_update.name != db_category.name:
        existing_category = db.query(Category).filter(
            Category.name == category_update.name,
            Category.id != db_category.id,
            scope_criterion(Category, db_category.user_id, db_category.entity_id),
        ).first()
        if existing_category:
            raise HTTPException(status_code=400, detail="Category with this name already exists")

    update_data = category_update.dict(exclude_unset=True)
    for field, value in update_data.items():
        setattr(db_category, field, value)

    db.commit()
    db.refresh(db_category)
    return db_category

@router.delete("/{category_id}")
def delete_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Soft delete a category (mark as inactive)"""
    db_category = get_accessible_or_404(db, Category, category_id, current_user, "Category not found")

    db_category.is_active = False
    db.commit()
    return {"message": "Category deleted successfully"}
