from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List, Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.models.category import Category
from app.models.user import User
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate

router = APIRouter()

@router.get("/", response_model=List[CategoryResponse])
def get_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    is_expense: Optional[bool] = Query(None, description="Filter by expense/income type"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
    entity_id: Optional[int] = Query(None, description="Filter by entity ID"),
):
    """Get all categories with optional filtering"""
    query = db.query(Category).filter(Category.user_id == current_user.id)

    if entity_id is not None:
        query = query.filter(Category.entity_id == entity_id)
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
):
    """Create a new category"""
    # Check if category name already exists for this user
    existing_category = db.query(Category).filter(
        Category.name == category.name,
        Category.user_id == current_user.id,
    ).first()
    if existing_category:
        raise HTTPException(status_code=400, detail="Category with this name already exists")

    db_category = Category(**category.dict(), user_id=current_user.id)
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
    category = db.query(Category).filter(
        Category.id == category_id,
        Category.user_id == current_user.id,
    ).first()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    return category

@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: int,
    category_update: CategoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an existing category"""
    db_category = db.query(Category).filter(
        Category.id == category_id,
        Category.user_id == current_user.id,
    ).first()
    if not db_category:
        raise HTTPException(status_code=404, detail="Category not found")

    # Check if new name conflicts with existing category
    if category_update.name and category_update.name != db_category.name:
        existing_category = db.query(Category).filter(
            Category.name == category_update.name,
            Category.user_id == current_user.id,
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
    db_category = db.query(Category).filter(
        Category.id == category_id,
        Category.user_id == current_user.id,
    ).first()
    if not db_category:
        raise HTTPException(status_code=404, detail="Category not found")

    db_category.is_active = False
    db.commit()
    return {"message": "Category deleted successfully"}
