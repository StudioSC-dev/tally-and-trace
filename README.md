# Tally & Trace

A **full-stack, type-safe monorepo** for personal and business financial management. Features a React web frontend, a FastAPI backend, a shared TypeScript package, and a React Native mobile app (coming soon). Built with the [react-kit](https://github.com/DivineDemon/react-kit) template structure for rapid, scalable development.

## Why I Built This

I developed Tally & Trace to solve my own need for a simple, flexible financial tracking tool that would replace my aging Google Sheet tracker. Existing solutions were either too complex, too expensive, or lacked the flexibility I needed to manage personal and business finances in one place. This app represents my ideal balance of functionality and simplicity, built with modern tools and best practices.

I built this with my own use cases (my personal use cases, my wife's, our household's and our potential business ventures) in mind. It might not fit yours right away, but do let me know if you have certain features in mind via seth@studiosc.dev.

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

- **Owner-Scoped Records**: Every account has one owner; a record is visible to the user who made it and to the owner of any account it touches, and every reference must belong to the same owner
- **Account Management**: Cash, e-wallets, savings, checking, and credit accounts with multi-currency support
- **Transaction Tracking**: Record income, expenses, and transfers with FX fields
- **Budget Entries**: Recurring income/expense items with configurable cadence and end rules
- **Allocations**: Savings goals, budgets, and period-based allocations
- **Wishlist**: Prioritised wishlist items linked to categories
- **Category Organisation**: Color-coded categories for transactions and budgets
- **Tags**: Your own tags on accounts, transactions and budget entries, with a built-in Household tag; a record also carries the tags on the accounts it is booked on, for filtering lists, summaries and projections
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
alembic upgrade head        # Apply migrations — REQUIRED before first run.
                            # Alembic owns the schema; the app no longer creates tables on boot.
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

**Local Development:**

| Service            | URL                          |
|--------------------|------------------------------|
| Frontend           | http://localhost:3000         |
| Backend API        | http://localhost:8000         |
| API Docs (Swagger) | http://localhost:8000/docs    |

**Production (Deployed):**

| Service            | Custom Domain                              |
|--------------------|--------------------------------------------|
| Frontend           | https://tallyandtrace.studiosc.dev         |
| Backend API        | https://api.tallyandtrace.studiosc.dev     |
| API Docs (Swagger) | https://api.tallyandtrace.studiosc.dev/docs |

---

## API Endpoints

All endpoints are prefixed with `/api/v1`.

### Auth
- `POST /auth/register` — Register a new user
- `POST /auth/login` — Login and receive a JWT
- `GET  /auth/me` — Get current user
- `PUT  /auth/me` — Update current user

Accounts, transactions and budget entries take `tag_ids` (your own tag ids) on
create and update — on update, omit it to keep the tags or send a list to
replace them — and return `tags` (`id`, `name`, `color`, `is_system`), listing
only your own tags.

`?tag=<id>` filters by effective tag: a record's own tags plus its owner's tags
on the accounts it is booked on (`account_id`; `transfer_from_account_id` and
`transfer_to_account_id` on transfers; a budget entry's `transfer_to_account_id`).
It applies to `GET /accounts/` (the account's own tags), `GET /transactions/`,
`GET /transactions/summary/period`, `GET /budget-entries/`, the `/forecast/*`
views and `GET /dashboard/snapshot`. Projections keep only the tagged events
from an unfiltered starting balance. A tag id you can't use gets an empty
result, the same as a tag with no records.

### Shared accounts

An account's owner can share it with another user as `viewer`, `editor` or
`admin` (Drive-style). Roles rank owner > admin > editor > viewer.

- **Reading:** you read a record if you created it or hold any role on an
  account it touches.
- **Writing:** you and the record's creator both need an edit role (editor or
  above) on every account the record touches, before and after the change. The
  owner of every account a record touches may also post, revert or delete it.
  Unposted records can be deleted by their creator, or by the owner of an
  account they touch. A record with no account is its creator's alone.
- **Account settings** (and tagging an account) need owner or admin; deleting
  or deactivating an account is the owner's alone. Shares are managed by the
  owner or an admin, and only the owner grants admin. A non-creator can't set
  or clear a record's category, allocation or recurring entry (400).
- **Loan terms** (rate, payment amount, term, first payment date, amortisation
  and the proposed split) are shown to the owner and admins only; an editor's
  loan schedule keeps the payment rows with those fields null. Prepayment is
  refused on a fixed loan, so anyone who can record payments on a loan can
  tell whether it is fixed.
- **Responses** carry `view`: `full` (you created it and can view every account
  it touches), `shared_full` (another editor's record; the creator's category,
  allocation, recurring-entry, receipt and invoice references are dropped and a
  read-only `category_name` is added) or `limited` (an explicit allowlist).
  Every record also carries `permissions` (`can_edit`, `can_delete`,
  `can_post`, `can_revert`, `can_tag`) and `created_by` (a display name such as
  "Alex P."). Accounts carry `my_role`, `owner_name` and `permissions`
  (`can_edit_settings`, `can_manage_shares`, `can_add_transactions`,
  `can_delete`).
- **Hidden accounts** appear as `{id: null, name}` with "Other account", "Loan
  payment" or "Card payment", and a description is shown only when you can view
  every account the record touches. A payment into a loan or card you can't
  view shows the whole amount and no fee or interest. Search matches displayed
  text only, and list filters only on accounts you can view (any other id
  matches nothing) and, for `is_reconciled` and `is_active`, only on records
  you see in full.
- **Projections** include shared accounts. Events you can't see in full are
  `limited` (`public_id`, `date`, `original_date`, `overdue`, `display_name`,
  `face_amount`, `cash_delta`, `currency`, `account`, `kind`). They depend on
  your scope: a card or wallet you can't view counts as billed or as ordinary
  cash, whatever its settings, so a transfer or card payment involving one can
  project differently for you than for its owner (on a shared card's
  statements, or on a joint account's transfers).
- **Attachments:** uploaded receipts are never served as public files. Fetch
  one from `GET /transactions/{id}/receipt` with your bearer token; it is
  returned only to a caller who sees the transaction in `full` view, and
  everyone else gets the same 404 as for a missing transaction. A stored
  upload's `receipt_url` (older rows included) is shown as that route; an
  external link is returned as entered. `invoice_url` has no upload and is
  returned as entered.
- **Removing, leaving or demoting a share** to viewer deactivates the former
  sharee's recurring entries on that account; their transactions stay.
- Demo users can neither share nor be shared with (403).

### Household viewer share

You can share your Household tag (only that system tag) read-only with another
user, chosen by exact email through the same rate-limited lookup as account
shares. It gives them your Household, never write access and never
`can_delete`:

- **Accounts:** the accounts you own and tag Household become visible to them
  with `my_role` `tag_viewer` (ranked below `viewer`), showing only `id`,
  `name`, `account_type`, `currency`, `balance`, the access fields (every
  permission false), `owner_name` and `tags`. Statements, loan schedules,
  shares and settings stay 404; balance history lists only the records they
  may read. An account share they also hold wins when its role is higher, so
  an editor on your joint account stays `editor` there.
- **Records:** they read your own records whose every account is yours and
  that either touch a Household-tagged account (rule b2) or carry your
  Household tag explicitly (rule c, including a record with no account).
  Another user's records on your accounts are never shown to them, in lists,
  search, balance history, summaries, projections or exports. Tagging an
  account Household exposes your own transactions on it.
- **Display:** records are `limited`. A description is shown for records on
  accounts they can see, and for records carrying your Household tag
  explicitly. A tag inherited from an account doesn't reveal the text of a
  record on one of your private accounts. Your Household tag is listed in a
  record's `tags` only when the record carries it explicitly. A Household bill
  on your private card or wallet shows its description with the account
  neutral.
- **Projections** include your Household-tagged accounts. Your explicitly
  Household-tagged records outside them (a bill on a private card or wallet,
  or a recurring entry with no account) are listed as Household occurrences:
  `cash_delta` 0, never in unassigned cash, and on a card only the part not
  already covered by payments from Household accounts (settled in the
  statement engine's order: transaction rows first, oldest statement first,
  then projected charges; Household lines first). A record on an account they
  also see directly is an ordinary event in their normal projection, never
  also an occurrence.
- **Revoking or leaving** removes access at once. Demo users can neither share
  nor be shared with (403).

### Household views

One sharer's Household at a time: `sharer_id` is a user whose Household tag
share you hold, or yourself (your own Household view, over your own
Household-tagged accounts). Any other id is 404. The view's scope is the
sharer's active Household-tagged accounts you can see; your own private
accounts are outside it.

- `GET    /household/` — The views you can open: `[{sharer_id, sharer_name, is_self}]`, your own first
- `GET    /household/{sharer_id}/dashboard` — `{sharer, accounts, month, upcoming}`: the scope accounts (as `/accounts/` returns them), this month's totals and the next 30 days
- `GET    /household/{sharer_id}/transactions` — The scope's transactions you may read and the sharer's Household occurrences, newest first, as `/transactions/` (`start_date`, `end_date`, `limit`, `offset`)
- `GET    /household/{sharer_id}/upcoming?days=` — `{sharer, items, days}`, items as `/forecast/upcoming`, each full item also with its `currency`
- `GET    /household/{sharer_id}/monthly?from=YYYY-MM&to=YYYY-MM` — Monthly totals (each bound defaults to this month and lies in 1900-01 through 2999-12; at most 36 months; 422 otherwise): `{sharer, from, to, months: [{month, kind, currencies}]}` with `kind` `recorded`, `current` or `projected`, and one line per currency, never converted: `income`, `expense`, `fees`, `moved_in`, `moved_out`, `paid_from_other_accounts`

Recorded months use posted transactions; the current month adds the projection
from today, and later months are projected. Income, expense and fees come from
the scope's cash accounts: credits and debits, card and loan payments (a card
charge counts when the card is paid), and transfer fees. A payment into a loan
or card the viewer can't see is one whole expense (principal and interest),
with no fee line, so its interest is never shown. A transfer between a
scope account and an account outside the scope that is not a card or loan is
"Moved in" or "Moved out" (your own deposit from a private account into the
joint account is "Moved in", and your private spending never appears).
"Paid from other accounts" is the remainder of the sharer's Household bills
outside the scope, after the payments into them from the Household's accounts
that you can read (a payment you can't read still settles the card, but never
covers a bill in your view, since it isn't in your expense). A payment covers
only bills in its own currency, never converted. A posted Household charge on
a card statement that is not yet settled is left to the projection: it counts
as covered by the planned and routed payments from the Household's accounts,
which the projection shows as expense, so the joint outflow plus the
remainder is always the charge, across recorded and projected months
together. A statement already settled, or past due with no further planned
payment, counts only posted payments.

### Accounts
- `GET    /accounts/` — List the accounts you own or that are shared with you
- `POST   /accounts/` — Create an account
- `GET    /accounts/{id}` — Get account details
- `PUT    /accounts/{id}` — Update an account (owner or admin)
- `DELETE /accounts/{id}` — Delete an account (owner)
- `GET    /accounts/{id}/balance` — Get account balance
- `GET    /accounts/{id}/statements` — A card's statements (viewers get a limited form)
- `GET    /accounts/{id}/loan-schedule` — A loan's schedule (viewers get a limited form)
- `GET    /accounts/{id}/shares` — The owner and every share (owner or admin)
- `POST   /accounts/{id}/shares` — Share with a user by exact email (`email`, `role`); resolved and rate-limited like `/users/lookup`, with the same 404 "No matching user"
- `PATCH  /accounts/{id}/shares/{share_id}` — Change a share's role
- `DELETE /accounts/{id}/shares/{share_id}` — Remove a share

### Shares and users
- `GET    /shares/received` — The shares you hold
- `DELETE /shares/received/{id}` — Leave a share
- `GET    /shares/received/household` — The Household tag shares you hold: `[{id, tag_id, sharer_id, sharer_name, created_at}]`
- `DELETE /shares/received/household/{id}` — Leave a Household tag share
- `GET    /users/lookup?email=` — `{id, display_name}` on an exact, case-insensitive email match; anything else is the same 404 "No matching user"; rate-limited

### Transactions
- `GET    /transactions/` — List transactions (paginated)
- `POST   /transactions/` — Create a transaction
- `GET    /transactions/{id}` — Get transaction details
- `PUT    /transactions/{id}` — Update a transaction
- `DELETE /transactions/{id}` — Delete a transaction
- `POST   /transactions/{id}/upload-receipt` — Upload a receipt (the creator; saved under a random name)
- `GET    /transactions/{id}/receipt` — The receipt file (only in `full` view; see Attachments)

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

### Tags
- `GET    /tags/` — List your tags (the Household system tag first)
- `POST   /tags/` — Create a tag (`name`, optional `color` as `#RRGGBB`); names are unique per user, ignoring case
- `GET    /tags/{id}` — Get a tag
- `PUT    /tags/{id}` — Rename or recolour a tag; the Household tag can be recoloured but not renamed
- `DELETE /tags/{id}` — Delete a tag and its links; the Household tag can't be deleted
- `GET    /tags/household/shares` — Who you share your Household tag with: `{tag_id, shares: [{id, tag_id, user_id, display_name, created_at}]}`
- `POST   /tags/household/shares` — Share your Household tag by exact email (`email`); rate-limited like `/users/lookup`, 404 "No matching user", 409 for yourself or a duplicate
- `DELETE /tags/household/shares/{id}` — Revoke a Household tag share

### Data export
- `GET    /data/export.json` — Download your data as JSON (an explicit, versioned schema), including your tags and their links to your records; other records you can read (and your own on an account you can no longer view) are exported in their limited form, and accounts reached through a Household tag share are listed with `my_role` `tag_viewer`
- `GET    /data/export.csv?table=<name>` — Download one table as CSV; without `table`, a ZIP of every table

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
- **Demo seeding**: On startup, the demo user (`demo@example.com`) and the Demo Partner (`demo.partner@example.com`) get the generic data in `app/constants/seed_data.json`, including the demo user's Joint Account shared with the partner as editor, the demo user's Household tag shared with the partner (so "Sign in as Demo Partner" opens their Household view), and the demo user's credit card routed to the joint account. The one-row `demo_state` table records `DEMO_SHAPE_VERSION` (in `app/core/seed.py`): when the row is missing, the version differs or a demo user is missing, only the two demo users' data is replaced; otherwise startup changes nothing. Bump the version whenever the demo data changes. Records name their tags in a `tags` list (Household, or a name from the top-level `tags`); the demo user's Household tag is kept across reseeds.
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

| Service               | Type         | Custom Domain                              |
|-----------------------|--------------|---------------------------------------------|
| `tally-and-trace-api` | Web Service  | `https://api.tallyandtrace.studiosc.dev`    |
| `tally-and-trace-web` | Static Site  | `https://tallyandtrace.studiosc.dev`        |

**Note:** The database is hosted on **Supabase** (not Render). Connection string is configured via the `DATABASE_URL` environment variable.

### Deploying

1. Connect the repo to Render as a **Blueprint**.
2. Render auto-creates the backend web service and static site from `render.yaml`.
3. Set the manual environment variables on the backend service:
   - `DATABASE_URL` — Supabase pooler connection string
   - `RESEND_API_KEY` — Resend API key for transactional emails
   - `RESEND_FROM_EMAIL` — Verified sender email address
4. Custom domains are configured in `render.yaml`:
   - Frontend: `tallyandtrace.studiosc.dev`
   - API: `api.tallyandtrace.studiosc.dev`
   - Add corresponding CNAME records in your DNS provider pointing to the Render service URLs
   - Render automatically provisions SSL certificates for custom domains

### Testing Production Deployment

#### Frontend Testing

1. **Access the web app:**
   ```bash
   https://tallyandtrace.studiosc.dev
   ```

2. **Verify functionality:**
   - User registration and login
   - Dashboard loads with account summaries
   - Navigation between pages (Accounts, Transactions, Allocations, Wishlist)
   - Responsive design on mobile devices
   - Dark mode toggle

#### API Testing

1. **Health check:**
   ```bash
   curl https://api.tallyandtrace.studiosc.dev/health
   ```
   Expected response: `{"status": "healthy"}`

2. **API documentation:**
   ```bash
   https://api.tallyandtrace.studiosc.dev/docs
   ```

3. **Test authentication flow:**
   ```bash
   # Register a new user
   curl -X POST https://api.tallyandtrace.studiosc.dev/api/v1/auth/register \
     -H "Content-Type: application/json" \
     -d '{
       "email": "test@example.com",
       "password": "SecurePass123!",
       "firstName": "Test",
       "lastName": "User"
     }'
   
   # Login
   curl -X POST https://api.tallyandtrace.studiosc.dev/api/v1/auth/login \
     -H "Content-Type: application/json" \
     -d '{
       "email": "test@example.com",
       "password": "SecurePass123!"
     }'
   ```

4. **Test protected endpoints** (requires JWT token from login):
   ```bash
   # Get current user
   curl https://api.tallyandtrace.studiosc.dev/api/v1/auth/me \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   
   # List accounts
   curl https://api.tallyandtrace.studiosc.dev/api/v1/accounts/ \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```

5. **Verify CORS configuration:**
   - Open browser DevTools → Network tab
   - Access `https://tallyandtrace.studiosc.dev`
   - Check API requests to `https://api.tallyandtrace.studiosc.dev`
   - Verify no CORS errors in the console

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

**Tally and trace!**
