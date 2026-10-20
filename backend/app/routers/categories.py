from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import List, Optional
from app.core.database import get_db
from app.core.auth import get_current_active_user
from app.core.access import get_owned_or_404, owned_criterion
from app.models.category import Category, CategoryKind
from app.models.user import User
from app.schemas.category import CategoryCreate, CategoryResponse, CategoryUpdate

router = APIRouter()


def _reconcile_kind(data: dict) -> None:
    """Keep `kind` and the legacy `is_expense` flag consistent.

    `kind` is the source of truth: when present, is_expense is derived from it
    (only an expense category counts as an expense). When only is_expense is
    supplied (legacy clients), kind is derived from it. Mutates `data` in place.
    """
    kind = data.get("kind")
    if kind is not None:
        kind_value = kind.value if isinstance(kind, CategoryKind) else str(kind)
        data["kind"] = kind_value
        data["is_expense"] = kind_value == CategoryKind.EXPENSE.value
    elif data.get("is_expense") is not None:
        data["kind"] = (
            CategoryKind.EXPENSE.value if data["is_expense"] else CategoryKind.INCOME.value
        )


def _name_taken(
    db: Session, user: User, name: str, kind: CategoryKind, exclude_id: Optional[int] = None
) -> bool:
    """Whether the user already owns a category with this exact name and kind.

    Uniqueness is per (name, kind) within the caller's own categories, so an
    income and an expense category may share a name. Inactive rows count.
    """
    query = db.query(Category.id).filter(
        Category.name == name,
        Category.kind == kind,
        owned_criterion(Category, user),
    )
    if exclude_id is not None:
        query = query.filter(Category.id != exclude_id)
    return query.first() is not None


def _name_taken_error(kind: CategoryKind) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=f"A category of kind '{kind.value}' with this name already exists",
    )

@router.get("/", response_model=List[CategoryResponse])
def get_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
    is_expense: Optional[bool] = Query(None, description="Filter by expense/income type"),
    kind: Optional[CategoryKind] = Query(None, description="Filter by category kind (income/expense/transfer)"),
    is_active: Optional[bool] = Query(None, description="Filter by active status"),
):
    """Get all categories with optional filtering"""
    # Categories are never shared: the caller's own only.
    query = db.query(Category).filter(owned_criterion(Category, current_user))

    if kind is not None:
        query = query.filter(Category.kind == kind)
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
    category_data = category.dict()
    _reconcile_kind(category_data)

    # Uniqueness follows the same scope as visibility: the caller's own
    # categories, per (name, kind). kind is always set here: is_expense
    # defaults to True, so _reconcile_kind derives it when it was omitted.
    kind = CategoryKind(category_data["kind"])
    if _name_taken(db, current_user, category.name, kind):
        raise _name_taken_error(kind)

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
    return get_owned_or_404(db, Category, category_id, current_user, "Category not found")

@router.put("/{category_id}", response_model=CategoryResponse)
def update_category(
    category_id: int,
    category_update: CategoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """Update an existing category"""
    db_category = get_owned_or_404(db, Category, category_id, current_user, "Category not found")

    update_data = category_update.dict(exclude_unset=True)
    _reconcile_kind(update_data)

    # Same scope as create: the owner's own categories, per (name, kind). A
    # change of name, of kind (via kind or legacy is_expense), or of both is
    # checked; an update that keeps both never clashes with itself.
    new_name = update_data.get("name") or db_category.name
    new_kind = CategoryKind(update_data.get("kind") or db_category.kind)
    if (new_name, new_kind) != (db_category.name, db_category.kind):
        if _name_taken(db, current_user, new_name, new_kind, exclude_id=db_category.id):
            raise _name_taken_error(new_kind)
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
    db_category = get_owned_or_404(db, Category, category_id, current_user, "Category not found")

    db_category.is_active = False
    db.commit()
    return {"message": "Category deleted successfully"}
