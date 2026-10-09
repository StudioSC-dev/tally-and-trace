# Browser regression checks

Standalone Playwright scripts that drive the real web app against a local API.
They are not part of `pnpm build`, the lint, or CI, and the repo does not depend
on Playwright. Run them by hand when you change the auth or session code.

| Script | Covers |
|---|---|
| `refresh-session-switch.cjs` | STU-239: a token refresh stays bound to the session that started it |

## Run

The scripts register users and write to the database. Use a **local, throwaway
Postgres only**. Never run the API from `backend/.env`, which may point at a
real database. The script refuses to run unless `DATABASE_URL` is on
`127.0.0.1` or `localhost`.

1. Start a local Postgres and create an empty database, for example:

   ```bash
   docker run -d --name tt-e2e-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16
   docker exec tt-e2e-pg psql -U postgres -c "CREATE DATABASE tt_e2e"
   ```

2. Run the API against it, with the backend virtualenv active. Export the
   settings in your shell: exported variables take priority over any
   `backend/.env`. Confirm the resolved database before migrating, and start the
   server from a directory with no `.env` file (settings read `.env` from the
   working directory):

   ```bash
   export DATABASE_URL='postgresql://postgres:pw@127.0.0.1:55432/tt_e2e'
   export SECRET_KEY='local-e2e-only'
   export ENVIRONMENT=development
   export BACKEND_CORS_ORIGINS_STR='http://localhost:5173'
   export FRONTEND_BASE_URL='http://localhost:5173'
   export RESEND_API_KEY='' SENTRY_DSN=''
   (cd backend && python -c "from app.core.config import settings; print(settings.DATABASE_URL)")  # must print the local URL
   (cd backend && alembic upgrade head)
   (cd /tmp && uvicorn app.main:app --app-dir "$OLDPWD/backend" --port 8000)
   ```

3. In another shell, start the dev server pointed at that API:

   ```bash
   cd frontend && VITE_API_URL=http://localhost:8000 pnpm dev --port 5173 --strictPort
   ```

4. Get Playwright outside the repo (no dependency is added here), then run the
   script from the repo root. `psql` must be on `PATH`, because the script
   marks its test users verified directly in the database.

   ```bash
   npm install --prefix /tmp/pw playwright@1.58.1
   npx --prefix /tmp/pw playwright install chromium
   export PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright
   export E2E_API_URL=http://localhost:8000 E2E_WEB_URL=http://localhost:5173
   node frontend/e2e/refresh-session-switch.cjs        # all scenarios
   node frontend/e2e/refresh-session-switch.cjs e      # one scenario: a..f
   ```

   `DATABASE_URL` must still be exported in this shell. Set `DEBUG=1` to log
   every API response. The script exits 0 only when every assertion passes, and
   prints `RESULT: <passed>/<total>`.

5. Drop the database afterwards, for example
   `docker rm -f tt-e2e-pg`.
