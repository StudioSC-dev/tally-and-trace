# Tally & Trace

A **full-stack, type-safe monorepo** for personal and business financial management. Features a React web frontend, a FastAPI backend, a shared TypeScript package, and a React Native mobile app (coming soon). Built with the [react-kit](https://github.com/DivineDemon/react-kit) template structure for rapid, scalable development.

---

## Project Structure

```
tally-and-trace/
├── backend/                  # FastAPI backend (Python)
│   ├── app/
│   │   ├── core/             # Config, DB engine, auth, seeding
│   │   ├── constants/        # Seed data (JSON)
│   │   ├── models/           # SQLAlchemy ORM models
│   │   ├── routers/          # API route definitions
│   │   ├── schemas/          # Pydantic request/response schemas
│   │   ├── services/         # Business-logic services
│   │   └── main.py           # FastAPI app entrypoint
│   ├── migrations/           # Alembic migration versions
│   ├── requirements.txt      # Python dependencies
│   └── env.example           # Backend environment variables
│
├── frontend/                 # React web app (TypeScript + Vite)
│   ├── src/
│   │   ├── routes/           # Route components (TanStack Router)
│   │   ├── store/            # Redux Toolkit + RTK Query services
│   │   ├── components/       # Reusable UI components
│   │   ├── contexts/         # React context providers
│   │   ├── hooks/            # Custom hooks
│   │   ├── utils/            # Frontend utilities
│   │   └── main.tsx          # App entrypoint
│   ├── vite.config.ts        # Vite build & dev-proxy config
│   └── package.json
│
├── mobile/                   # React Native app (Expo, coming soon)
│   ├── app/
│   │   ├── (auth)/           # Auth screens (login, register)
│   │   ├── (tabs)/           # Tab screens (dashboard, accounts, etc.)
│   │   └── _layout.tsx       # Root layout
│   ├── src/
│   │   ├── components/       # Mobile UI components
│   │   ├── contexts/         # Mobile context providers
│   │   ├── store/            # Redux store (mirrors web)
│   │   └── utils/            # Mobile utilities
│   ├── app.json              # Expo configuration
│   └── package.json
│
├── packages/
│   └── shared/               # Shared TypeScript types & utilities
│       └── src/
│           ├── types/         # API & auth type definitions
│           ├── utils/         # Currency & date helpers
│           └── index.ts       # Package entry
│
├── render.yaml               # Render Blueprint (backend + frontend)
├── pnpm-workspace.yaml       # pnpm workspace config
├── scripts/
│   └── setup-supabase.sh     # Supabase DB setup helper
└── package.json              # Root scripts & workspace config
```

---

## Features

- **Multi-Entity Architecture**: Manage personal and business finances under separate entities
- **Account Management**: Cash, e-wallets, savings, checking, and credit accounts with multi-currency support
- **Transaction Tracking**: Record income, expenses, and transfers with FX fields
- **Budget Entries**: Recurring income/expense items with configurable cadence and end rules
- **Allocations**: Savings goals, budgets, and period-based allocations
- **Wishlist**: Prioritised wishlist items linked to categories and entities
- **Category Organisation**: Color-coded categories for transactions and budgets
- **Auth & Email**: JWT authentication with email verification and password reset (via Resend)
- **Shared Package**: `@tally-trace/shared` provides types and utilities consumed by both web and mobile
- **Type Safety**: Pydantic v2 on the backend, TypeScript everywhere on the frontend
- **Mobile App** *(coming soon)*: React Native (Expo) app with NativeWind styling, tab navigation, and secure token storage

---

## Quick Start

### Prerequisites

- **Python 3.10+** (recommended: 3.12)
- **Node.js 18+** and **pnpm**
- **PostgreSQL** (local or Supabase)

### 1. Clone and Install

```bash
# Install frontend, mobile, and shared workspace dependencies
pnpm install
```

### 2. Setup Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp env.example .env         # Edit .env with your DB URL and secrets
```

### 3. Start Development Servers

**Backend:**
```bash
cd backend
uvicorn app.main:app --reload
```

**Frontend:**
```bash
pnpm run dev:frontend
```

**Mobile** *(requires Expo Go or a simulator)*:
```bash
pnpm run dev:mobile
```

### 4. Access the Application

| Service            | URL                          |
|--------------------|------------------------------|
| Frontend           | http://localhost:3000         |
| Backend API        | http://localhost:8000         |
| API Docs (Swagger) | http://localhost:8000/docs    |

---

## API Endpoints

All endpoints are prefixed with `/api/v1`.

### Auth
- `POST /auth/register` — Register a new user
- `POST /auth/login` — Login and receive a JWT
- `GET  /auth/me` — Get current user
- `PUT  /auth/me` — Update current user

### Accounts
- `GET    /accounts/` — List accounts
- `POST   /accounts/` — Create an account
- `GET    /accounts/{id}` — Get account details
- `PUT    /accounts/{id}` — Update an account
- `DELETE /accounts/{id}` — Delete an account
- `GET    /accounts/{id}/balance` — Get account balance

### Transactions
- `GET    /transactions/` — List transactions (paginated)
- `POST   /transactions/` — Create a transaction
- `GET    /transactions/{id}` — Get transaction details
- `PUT    /transactions/{id}` — Update a transaction
- `DELETE /transactions/{id}` — Delete a transaction

### Categories
- `GET    /categories/` — List categories
- `POST   /categories/` — Create a category
- `GET    /categories/{id}` — Get category details
- `PUT    /categories/{id}` — Update a category
- `DELETE /categories/{id}` — Delete a category

### Allocations
- `GET    /allocations/` — List allocations
- `POST   /allocations/` — Create an allocation
- `GET    /allocations/{id}` — Get allocation details
- `PUT    /allocations/{id}` — Update an allocation
- `DELETE /allocations/{id}` — Delete an allocation

### Budget Entries
- `GET    /budget-entries/` — List budget entries
- `POST   /budget-entries/` — Create a budget entry
- `GET    /budget-entries/{id}` — Get budget entry details
- `PUT    /budget-entries/{id}` — Update a budget entry
- `DELETE /budget-entries/{id}` — Delete a budget entry

### Entities
- `GET    /entities/` — List entities for current user
- `POST   /entities/` — Create an entity
- `GET    /entities/{id}` — Get entity details

### Wishlist
- `GET    /wishlist/` — List wishlist items
- `POST   /wishlist/` — Create a wishlist item
- `GET    /wishlist/{id}` — Get wishlist item
- `PUT    /wishlist/{id}` — Update a wishlist item
- `DELETE /wishlist/{id}` — Delete a wishlist item

---

## Development

### Backend

- **Database migrations**: Managed with Alembic.
  ```bash
  cd backend && source .venv/bin/activate
  alembic revision --autogenerate -m "describe change"
  alembic upgrade head
  ```
- **Auto-router inclusion**: All files in `app/routers/` are automatically registered.
- **Database seeding**: Initial data loaded from `app/constants/seed_data.json` on startup.
- **Type safety**: Pydantic v2 for request/response validation.

### Frontend (Web)

- **File-based routing**: TanStack Router
- **State management**: Redux Toolkit with RTK Query
- **Styling**: Tailwind CSS
- **API proxy**: Vite dev server proxies `/api` to `http://localhost:8000`

### Mobile (Coming Soon)

- **Framework**: React Native via Expo SDK 52
- **Routing**: Expo Router with file-based routes
- **Styling**: NativeWind (Tailwind CSS for React Native)
- **State management**: Redux Toolkit + RTK Query (mirrors web store)
- **Secure storage**: `expo-secure-store` for token persistence

### Shared Package

`@tally-trace/shared` is consumed by both `frontend` and `mobile` via the pnpm workspace. It contains:
- **Types** (`types/api.ts`, `types/auth.ts`): shared API response/request interfaces
- **Utilities** (`utils/currency.ts`, `utils/date.ts`): common formatting helpers

### Adding New Features

1. **Backend**: Add models in `backend/app/models/`, schemas in `backend/app/schemas/`, and routers in `backend/app/routers/`.
2. **Shared types**: Update `packages/shared/src/types/` and re-export from `index.ts`.
3. **Web frontend**: Add routes in `frontend/src/routes/` and API endpoints in `frontend/src/store/api.ts`.
4. **Mobile**: Add screens in `mobile/app/` and wire up the shared store.

---

## Deployment

Both the backend and the web frontend are deployed on **Render** via the `render.yaml` Blueprint.

| Service               | Type         | URL (default)                                   |
|-----------------------|--------------|--------------------------------------------------|
| `tally-and-trace-api` | Web Service  | `https://tally-and-trace-api.onrender.com`       |
| `tally-and-trace-web` | Static Site  | `https://tally-and-trace-web.onrender.com`       |
| `tally-and-trace-db`  | PostgreSQL   | Internal connection string                       |

### Deploying

1. Connect the repo to Render as a **Blueprint**.
2. Render auto-creates the backend web service, static site, and PostgreSQL database.
3. Set the two manual environment variables on the backend service:
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
4. (Optional) Add a custom domain to the static site and update `BACKEND_CORS_ORIGINS_STR` / `FRONTEND_BASE_URL` on the backend accordingly.

### Mobile Distribution

The mobile app will be distributed via **Expo Application Services (EAS)** for both iOS and Android builds. Details will be added once the mobile app is feature-complete.

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Ensure all tests pass
5. Submit a pull request

---

**Happy accounting!**
