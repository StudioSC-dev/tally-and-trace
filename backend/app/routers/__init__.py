from fastapi import APIRouter
from app.routers import (
    auth,
    accounts,
    transactions,
    categories,
    allocations,
    budget_entries,
    entities,
    wishlist,
    dashboard,
    forecast,
    data_portability,
)

# Central API router. Every router module below is registered here; adding a
# router file is NOT enough — it must be included in this list to be reachable.
api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["authentication"])
api_router.include_router(accounts.router, prefix="/accounts", tags=["accounts"])
api_router.include_router(transactions.router, prefix="/transactions", tags=["transactions"])
api_router.include_router(categories.router, prefix="/categories", tags=["categories"])
api_router.include_router(allocations.router, prefix="/allocations", tags=["allocations"])
api_router.include_router(budget_entries.router, prefix="/budget-entries", tags=["budget_entries"])
api_router.include_router(entities.router, prefix="/entities", tags=["entities"])
api_router.include_router(wishlist.router, prefix="/wishlist", tags=["wishlist"])
api_router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
api_router.include_router(forecast.router, prefix="/forecast", tags=["forecast"])
api_router.include_router(data_portability.router, prefix="/data", tags=["data-portability"])
