# CLAUDE.md
# Instructions for Claude — studiosc/Tally & Trace

This file governs how Claude should behave in every session that touches this codebase.
Read this before writing, editing, or reviewing any code.

---

## Project Identity

- **Project name:** Tally & Trace (`accounting-for-dummies-fastapi`)
- **Repo:** `accounting-for-dummies-fastapi` (the product name is "Tally & Trace")
- **Owner handle:** `studiosc`
- **Purpose:** A simple, flexible, type-safe financial tracker for personal, household, and business money — the replacement for an aging Google Sheet. Multi-entity by design (personal + business under one login), multi-currency, with accounts, transactions, recurring budget entries, savings-goal allocations, and a prioritised wishlist.
- **Nature:** Personal-use product first (Seth's, his wife's, the household's, and future business ventures), portfolio piece second. Featured at https://www.studiosc.dev/work/tallyandtrace and https://www.studiosc.dev/blog/tallyandtrace.
- **Live:** web `https://tallyandtrace.studiosc.dev` · API `https://api.tallyandtrace.studiosc.dev` (Render free tier — expect cold starts).

> **Heads-up for future sessions:** this repo predates the conventions used in `studiosc-centralcommand` and `studiosc-portfolio`. It was largely Cursor-built and carries real drift between what is *documented*, what is *built*, and what is *wired up*. Trust the code over the README. See **Known Issues & Drift** below before assuming a feature works end-to-end.

---

## Prime Directives

1. **Correctness of money is non-negotiable.** Balances, FX conversion, transfers, and allocation math must be exact. Use `Decimal`/`DECIMAL(15,2)` end to end — never floats for money. Any change that touches a financial calculation needs a test.
2. **Never make assumptions.** If a requirement, field name, or integration detail is unclear, stop and ask. Do not guess schema or API shapes — this repo has enough drift that guessing is dangerous.
3. **Type safety everywhere.** Pydantic v2 on the backend; TypeScript (no `any` without approval) on web and mobile. Shared contracts live in `@tally-trace/shared` and must stay the single source of truth for cross-cutting types.
4. **Keep the schema story single-source.** Alembic migrations are the source of truth for the database. Do **not** add new schema via the raw-SQL startup block (see Known Issues) — that path is being retired, not extended.
5. **Multi-entity and multi-user by default.** Every data-bearing feature is scoped to a user and (where applicable) an entity. Never hardcode a single user or a single entity.
6. **Minimise cost.** Runs on free tiers (Render, Supabase, Resend). Flag anything that needs a paid service and offer the zero-cost path first.
7. **Wire what you build.** A router, screen, or endpoint isn't "done" until it is registered, reachable, and exercised end to end. This repo's biggest problem is built-but-unwired features — don't add to the pile.

---

## Stack Reference

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces (`pnpm@10`) | `frontend`, `mobile`, `packages/shared`; `backend` is a separate Python project |
| Backend framework | FastAPI (>=0.104) | Python 3.10+ (CI runs 3.11; README recommends 3.12) |
| Validation | Pydantic v2 + pydantic-settings | request/response schemas in `backend/app/schemas/` |
| ORM | SQLAlchemy 2.0 (sync) | models in `backend/app/models/`; `psycopg2-binary` driver |
| Migrations | Alembic | `backend/migrations/versions/` |
| Database | PostgreSQL on Supabase | `DATABASE_URL` = Supabase pooler string |
| Auth | JWT (python-jose, HS256) + bcrypt (passlib) | 30-min access tokens, **no refresh tokens yet** |
| Email | Resend | verification + password reset; `app/services/email.py` |
| Web frontend | React 18 + Vite 5 + TypeScript 5 | `frontend/` |
| Web routing | TanStack Router (file-based) | `frontend/src/routes/`, generated `routeTree.gen.ts` |
| Web state/data | Redux Toolkit + RTK Query | `frontend/src/store/` |
| Web styling | Tailwind CSS v3 + "paper" design tokens | semantic tokens only — see **Design System** below |
| Mobile | React Native via Expo (SDK 52) | `mobile/` — **scaffolded, not feature-complete** |
| Mobile styling | NativeWind | |
| Mobile storage | expo-secure-store | token persistence |
| Shared package | `@tally-trace/shared` | types (`api.ts`, `auth.ts`) + utils (`currency.ts`, `date.ts`) |
| Hosting | Render (Blueprint `render.yaml`) | API web service + static web site |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | lint/build/deploy-hook; **tests currently non-blocking** |

---

## Repository Structure

```
accounting-for-dummies-fastapi/
├── backend/                       # FastAPI (Python) — its own project, not in the pnpm workspace
│   ├── app/
│   │   ├── core/                  # config, database engine, auth, seed, init_db, entity_context, password
│   │   ├── constants/             # seed_data.json
│   │   ├── models/                # SQLAlchemy ORM models (+ relationships wired in models/__init__.py)
│   │   ├── routers/               # API routes — must be registered in routers/__init__.py
│   │   ├── schemas/               # Pydantic v2 schemas
│   │   ├── services/              # email.py, forecast.py
│   │   └── main.py                # app entrypoint (CORS, lifespan seed, health)
│   ├── migrations/versions/       # Alembic migrations
│   ├── requirements.txt
│   └── env.example
├── frontend/                      # React + Vite web app
│   └── src/{routes,store,components,contexts,hooks,utils}
├── mobile/                        # Expo React Native app (WIP)
│   └── app/{(auth),(tabs)}  ·  src/{store,contexts,components,utils}
├── packages/shared/               # @tally-trace/shared — cross-platform types + utils
├── render.yaml                    # Render Blueprint (api + web)
├── pnpm-workspace.yaml
└── package.json                   # root scripts (dev:frontend, dev:mobile, build)
```

### Router wiring
All eleven routers are registered in `backend/app/routers/__init__.py`: `auth, accounts, transactions, categories, allocations, budget_entries, entities, wishlist, dashboard, forecast, data_portability`.

**Adding a router file is not enough to make it reachable** — it must be included in `api_router` there. This repo shipped five fully-implemented-but-unregistered routers for months (fixed in Phase 0, Session 1); that's the failure mode this file exists to prevent. Check `routers/__init__.py` before assuming an endpoint is live, and register + smoke-test anything you add.

---

## Data Model (tables)

Core tables (see `backend/app/models/` for the authoritative shape; Alembic migrations own the schema):

- `users` — email/password, `is_verified`, `default_currency`, `onboarding_completed`
- `entities` + `entity_memberships` — multi-entity architecture (`personal` | `business`; roles `owner`/`member`)
- `accounts` — `account_type` (cash/e_wallet/savings/checking/credit), `balance`, `currency`, credit-card fields (`credit_limit`, `due_date`, `billing_cycle_start`, `days_until_due_date`)
- `categories` — colour-coded, `is_expense`
- `transactions` — `transaction_type` (debit/credit/transfer), FX fields (`original_amount`/`currency`, `exchange_rate`, `projected_*`), `transfer_from/to_account_id`, `transfer_fee`, receipt/invoice URLs, reconciliation + recurrence flags
- `allocations` — savings/budget/goal, `target_amount`/`current_amount`/`monthly_target`, period fields + JSONB `configuration`
- `budget_entries` — recurring income/expense with `cadence`, `next_occurrence`, `end_mode`/`end_date`/`max_occurrences`, autopay
- `wishlist_items` — priority, estimated cost, target date, purchased flag
- `email_tokens` — verification + password-reset tokens

Enums live as Postgres types (`accounttype`, `transactiontype`, `allocationtype`, `budgetentrytype`, `recurrencefrequency`, `currencytype`, `entitytype`, `memberrole`, `wishlistpriority`, `allocationperiodfrequency`). Supported currencies: PHP (default), USD, EUR, GBP, JPY, AUD, CAD, CHF, CNY, SGD.

---

## Entity Context

`app/core/entity_context.py` resolves the active entity from `?entity_id=` **or** the `X-Entity-Id` header (header wins) and verifies membership. `get_active_entity` returns `None` when no id is supplied (callers fall back to user-scoped queries); `require_entity_owner` enforces the owner role. **The web client does not send `X-Entity-Id` yet**, so entity scoping is effectively dormant on the frontend — wiring it is part of making multi-entity real.

---

## Key Commands

```bash
# Install JS workspaces (frontend, mobile, shared)
pnpm install

# Backend
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp env.example .env
uvicorn app.main:app --reload                        # http://localhost:8000  (docs at /docs)
alembic revision --autogenerate -m "describe change"
alembic upgrade head

# Frontend
pnpm run dev:frontend        # http://localhost:3000 (proxies /api → :8000)
pnpm run build:frontend

# Mobile
pnpm run dev:mobile          # Expo

# Shared
pnpm run build:shared
```

---

## Commit Conventions

Use **Conventional Commits**: `<type>(<scope>): <summary>` — imperative, lowercase, no trailing period, ≤72 chars.

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`.

Scopes map to the repo: `backend`, `web`, `mobile`, `shared`, `db` (migrations), `ci`, `infra` (render/deploy).

One commit per feature step. One line only — no body, ever.

---

## Design System ("paper")

The web app uses a two-theme semantic token system ported from `studiosc-portfolio`.
Full spec, status and remaining phases: **`docs/theme-redesign.md`**. The rules:

- **Semantic tokens only.** `paper` / `surface` / `sunken` · `line` / `line-strong` ·
  `ink` / `body` / `muted` · `ok` / `warn` / `info` / `danger`. Declared in
  `frontend/tailwind.config.js`, valued in `frontend/src/assets/index.css`.
- **No raw palette classes.** `bg-blue-500`, `text-gray-900`, `border-slate-200` are drift.
- **No `dark:` variants, ever.** `darkMode` is unset — themes swap token *values* via
  `data-theme`, not class names. A `dark:` variant does not compile; it is silently dead code.
- **Status is a dot + mono label** (`.badge` + `.dot-ok|warn|info|danger`), never a tinted pill.
  Never put `bg-X` and `text-X` of the same token on one element — that renders invisible.
- **Serif is display-only** (page titles, wordmark); section headings use `.subhead`.
- Theme state lives on `<html>`, set by a blocking script in `index.html` before first
  paint, read via `useTheme()` (`useSyncExternalStore`). There is no `ThemeContext`.
- **`tsc` and `vite build` do not catch design-system breakage** — an unknown Tailwind
  class is silently ignored. Verify visually or with the audits described in the doc.
- `mobile/` (NativeWind) is deliberately not migrated yet.

---

## Phase Roadmap

Detailed, living version (with rationale and per-item status) lives in **`HANDOVER.md`**. Summary:

- **Phase 0 — Stabilize & wire up:** register the 5 orphaned routers; retire the raw-SQL startup DDL in favour of Alembic-only + FastAPI `lifespan`; remove the demo-user onboarding reset from prod startup; strip `console.log` from the API client; unify the hardcoded/duplicated token-expiry config; replace deprecated `datetime.utcnow()`; make CI actually gate (drop the `|| true`). **Plus deployment perf (stay on Render + Supabase):** pin the backend to the Singapore region to co-locate with Supabase, add a keep-alive pinger against free-tier cold starts, and make cold boots cheap. See HANDOVER "Deployment Topology & Performance".
- **Phase 1 — Test & auth foundation:** pytest suite for money math (balances, FX, transfers, allocations); Playwright E2E for auth + core CRUD; refresh-token flow with silent refresh (replace the hard 401→logout); wire multi-entity end to end (entity switcher + `X-Entity-Id`).
- **Phase 2 — Finish the half-built features:** UIs for wishlist, dashboard snapshot, cash-flow forecast, and data export/import (backends already exist); category & entity management screens; budget-entry → transaction materialisation.
- **Phase 3 — Mobile parity:** complete the Expo app to web parity; EAS build pipeline.
- **Phase 4 — Polish & growth:** FX auto-rates, reconciliation, receipt OCR, reporting/exports, upcoming-bill notifications, i18n.
- **Phase 5 — LLM connector (MCP):** an MCP server (own monorepo package) that calls the REST API so users can read summaries and make updates by talking to their LLM. Read tools first, guarded write tools second. **Gated on Phase 1 auth** — needs a revocable personal-access-token / OAuth client, not the 30-min JWT.

**Deployment note:** this project intentionally stays on **Render + Supabase** (no Vercel here — that's the portfolio; no Cloudflare — that's Central Command). It is the portfolio showcase for that stack. Optimise within it; do not propose migrating off it.

---

## What Claude Should Never Do

- Use floats for money — `Decimal`/`DECIMAL(15,2)` only.
- Add new schema through the raw-SQL startup block in `main.py` — use Alembic migrations.
- Introduce `any` (TS) or untyped dicts crossing the API boundary without approval.
- Mark a router/screen "done" without registering and exercising it end to end.
- Hardcode a single user or entity into business logic.
- Hardcode secrets, API keys, `SECRET_KEY`, or email addresses in source.
- Assume a documented endpoint is live — check `routers/__init__.py` first (see Router wiring).
- Add a dependency without justifying it, or suggest a non-free-tier service without flagging the cost.
- Leave `console.log`/debug logging of request/response bodies in committed code.
- Write a `dark:` variant or a raw palette class (`bg-blue-500`, `text-gray-900`) in the web app — see **Design System**.
- Treat a green `tsc`/`vite build` as proof a styling change works — unknown Tailwind classes are silently ignored.
