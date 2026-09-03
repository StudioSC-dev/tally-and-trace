# CLAUDE.md
# Instructions for Claude — Tally & Trace

This file governs how Claude should behave in every session that touches this codebase.
Read this before writing, editing, or reviewing any code.

---

## Project Identity

- **Project name:** Tally & Trace (`accounting-for-dummies-fastapi`)
- **Repo:** `smpalileo/accounting-for-dummies-fastapi`
- **Purpose:** Multi-entity, multi-currency financial tracker for personal and business
  finances. Web app, API, and mobile app (Expo, in progress).
- **Nature:** Portfolio/demo project. Decisions should reflect best practices and be
  presentable to potential employers or collaborators.

---

## Prime Directives

1. **Never make assumptions.** If anything is unclear — a requirement, a file path, a
   variable name, an integration detail — stop and ask.
2. **Minimize cost.** Free tiers only (Render, Supabase). Flag immediately if a solution
   requires paid services.
3. **TypeScript strict** in all frontend/shared code. No `any` types unless explicitly
   approved.
4. **Ask before adding dependencies.** Every new pip or npm package must be justified.

---

## Stack Reference

| Layer | Choice |
|---|---|
| Backend | FastAPI (Python 3.12) |
| ORM | SQLAlchemy |
| Database | PostgreSQL (Supabase) |
| Migrations | Alembic |
| Auth | JWT (python-jose) |
| Email | Resend |
| Frontend | React + Vite + TypeScript |
| Frontend state | Redux Toolkit + RTK Query |
| Frontend routing | TanStack Router |
| Mobile | React Native (Expo) |
| Shared types | `@tally-trace/shared` (pnpm workspace) |
| Monorepo | pnpm workspaces |
| Hosting | Render (free tier) |

---

## Monorepo Structure

```
tally-and-trace/
├── backend/                  → FastAPI backend (Python)
│   ├── app/
│   │   ├── core/             → config, DB engine, auth, seeding
│   │   ├── constants/        → seed data (JSON)
│   │   ├── models/           → SQLAlchemy ORM models
│   │   ├── routers/          → API route definitions
│   │   ├── schemas/          → Pydantic request/response schemas
│   │   ├── services/         → business-logic services
│   │   └── main.py           → FastAPI app entrypoint
│   └── migrations/           → Alembic migration versions
├── frontend/                 → React web app (Vite)
│   └── src/
│       ├── routes/           → route components (TanStack Router)
│       ├── store/            → Redux Toolkit + RTK Query
│       ├── components/       → reusable UI components
│       ├── contexts/         → React context providers
│       ├── hooks/            → custom hooks
│       └── utils/            → frontend utilities
├── mobile/                   → React Native app (Expo)
├── packages/
│   └── shared/               → shared TypeScript types & utilities
├── docs/                     → design docs
├── render.yaml               → Render Blueprint
└── scripts/                  → setup helpers
```

---

## Session Workflow

Follow [docs/linear-workflow.md](docs/linear-workflow.md) — update HANDOVER.md and
Linear after every session; create tickets before writing code in planning sessions.

**Linear project:** Tally & Trace (create project in Linear when first needed)
**Labels:** `Trailhead - TT` on every ticket, plus type labels (`Feature`, `Bug`, etc.)
and domain labels (`Frontend`, `Backend`, `Mobile`) as appropriate.

---

## Commit Conventions

**Conventional Commits**, one line only — no body, ever.

```
<type>(<scope>): <short summary>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`.
Scopes: `api`, `web`, `mobile`, `shared`, `infra`.

Summary: lowercase, imperative, no period, under 72 characters.

---

## What Claude Should Never Do

- Add `any` types without asking first
- Install a new dependency without justifying it
- Hard-code secrets, API keys, or email addresses in source files
- Suggest hosting outside of Render or Supabase free tiers without flagging cost
- Skip Alembic migration files when changing the database schema
- Design any feature for a single user — always assume multi-user
