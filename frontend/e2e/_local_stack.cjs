// A local API and web app for the browser checks, started against a throwaway
// database and nothing else. The e2e scripts reach an API only through this.
//
// - DATABASE_URL must pass the backend test guard's URL rules (local host,
//   throwaway database name, no query string); the password is never printed.
// - Every child (alembic, uvicorn, pnpm dev, psql) gets one sanitised env:
//   PATH, HOME and VIRTUAL_ENV only, no PG* routing variable, the dotenv file
//   disabled, and the guarded DATABASE_URL.
// - Alembic runs from <repo>/backend (alembic.ini's script_location is
//   relative); uvicorn runs from the temp directory, so no .env is in reach.
// - Children are killed when the process exits.
//
// Usage:
//   const { startLocalStack } = require('./_local_stack.cjs')
//   const stack = await startLocalStack()
//   stack.apiUrl, stack.webUrl, stack.psql(sql), stack.verifyUser(email), stack.stop()
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const os = require('os')
const pathMod = require('path')
const fs = require('fs')

const REPO = pathMod.resolve(__dirname, '..', '..')
const BACKEND = pathMod.join(REPO, 'backend')
const FRONTEND = pathMod.join(REPO, 'frontend')

// The variables libpq reads to route a connection somewhere the URL doesn't say.
const PG_ROUTING = ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGSYSCONFDIR', 'PGOPTIONS']
const SCHEMES = ['postgresql:', 'postgresql+psycopg2:', 'postgresql+psycopg:']
const HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]']
const DB_NAME = /^tt_test_[a-z0-9_]+$/

/** The reason a URL is refused, or null. Mirrors backend/app/tests/_db_guard.py. */
function refuseDatabaseUrl(raw) {
  if (!raw) return 'DATABASE_URL is not set'
  let url
  try { url = new URL(raw) } catch { return 'DATABASE_URL is not a URL' }
  if (!SCHEMES.includes(url.protocol)) return `scheme ${url.protocol.replace(/:$/, '')} is not allowed`
  if (url.search !== '' || raw.includes('?')) return 'a query string is not allowed'
  if (url.hash !== '' || raw.includes('#')) return 'a fragment is not allowed'
  // Judge the whole authority: a second `@` or a `,` anywhere in it makes libpq
  // and the WHATWG parser disagree about the host.
  const authority = raw.slice(raw.indexOf('//') + 2).split('/')[0]
  if (authority.split('@').length > 2) return 'more than one unescaped @ is not allowed'
  if (authority.includes(',')) return 'more than one host is not allowed'
  if (!HOSTS.includes(url.hostname)) return `host ${url.hostname || '(none)'} is not local`
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (name !== 'tally_trace_test' && !DB_NAME.test(name)) return `database ${name || '(none)'} is not a throwaway name`
  return null
}

/** A TCP port nothing is listening on. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(url, ms, isOk = (res) => res.ok) {
  const until = Date.now() + ms
  let last = 'no response'
  while (Date.now() < until) {
    try {
      const res = await fetch(url)
      if (isOk(res)) return
      last = `status ${res.status}`
    } catch (e) { last = e.cause?.code || e.message }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${url} not ready after ${ms} ms (${last})`)
}

async function startLocalStack(options = {}) {
  const raw = process.env.DATABASE_URL || ''
  const refused = refuseDatabaseUrl(raw)
  if (refused) {
    console.error(`REFUSING DATABASE_URL: ${refused}`)
    process.exit(2)
  }
  const venv = process.env.VIRTUAL_ENV || pathMod.join(BACKEND, '.venv')
  const bin = (name) => pathMod.join(venv, 'bin', name)
  for (const tool of ['alembic', 'uvicorn']) {
    if (!fs.existsSync(bin(tool))) {
      console.error(`Missing ${bin(tool)}: create the backend virtualenv (see frontend/e2e/README.md).`)
      process.exit(2)
    }
  }

  const apiPort = options.apiPort || await freePort()
  const webPort = options.webPort || await freePort()
  const apiUrl = `http://127.0.0.1:${apiPort}`
  const webUrl = `http://localhost:${webPort}`

  // One sanitised env for every child: nothing inherited but these three.
  const env = {}
  for (const key of ['PATH', 'HOME', 'VIRTUAL_ENV']) if (process.env[key]) env[key] = process.env[key]
  for (const key of PG_ROUTING) delete env[key]
  Object.assign(env, {
    TT_DISABLE_DOTENV: '1',
    DATABASE_URL: raw,
    SECRET_KEY: 'local-e2e-only',
    ENVIRONMENT: 'development',
    BACKEND_CORS_ORIGINS_STR: `${webUrl},http://127.0.0.1:${webPort}`,
    FRONTEND_BASE_URL: webUrl,
    RESEND_API_KEY: '',
    SENTRY_DSN: '',
    // The installment job's token (STU-343 Plan B): local only. With it set the job
    // endpoint answers and the app labels auto-post "each morning".
    JOB_TOKEN: 'local-e2e-only',
  })
  // psql takes a plain postgresql:// URL.
  const psqlUrl = raw.replace(/^postgresql\+\w+:/, 'postgresql:')

  const children = []
  const stop = () => {
    for (const child of children.splice(0)) {
      // Each child leads its own process group, so pnpm's vite goes with it.
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    }
  }
  process.on('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(130) })

  const logs = []
  const launch = (cmd, args, cwd, extraEnv = {}) => {
    const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const tag = pathMod.basename(cmd)
    const keep = (chunk) => {
      logs.push(`[${tag}] ${chunk}`)
      if (logs.length > 200) logs.shift()
      if (process.env.DEBUG) process.stdout.write(`[${tag}] ${chunk}`)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    children.push(child)
    return child
  }
  const fail = (message) => {
    console.error(message)
    console.error(logs.join('').slice(-4000))
    stop()
    process.exit(2)
  }

  // Alembic from backend/, where alembic.ini's relative script_location resolves.
  try {
    execFileSync(bin('alembic'), ['upgrade', 'head'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    fail(`alembic upgrade head failed:\n${String(e.stderr || e.message).slice(-3000)}`)
  }

  launch(bin('uvicorn'), ['app.main:app', '--app-dir', BACKEND, '--host', '127.0.0.1', '--port', String(apiPort)], os.tmpdir())
  launch('pnpm', ['dev', '--port', String(webPort), '--strictPort', '--host', 'localhost'], FRONTEND, { VITE_API_URL: apiUrl })
  try {
    await waitFor(`${apiUrl}/health`, 60000)
    await waitFor(`${webUrl}/`, 60000)
  } catch (e) {
    fail(e.message)
  }

  /** Runs one statement through psql with the sanitised env; returns its output. */
  const psql = (sql) =>
    execFileSync('psql', [psqlUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, encoding: 'utf8' }).trim()

  /** Marks a registered user verified and onboarded; anything but `UPDATE 1` aborts the run. */
  const verifyUser = (email) => {
    if (!/^[a-z0-9.+_-]+@example\.com$/.test(email)) throw new Error(`unexpected e2e email ${email}`)
    const out = psql(`UPDATE users SET is_verified = true, onboarding_completed = true WHERE email = '${email}'`)
    if (out !== 'UPDATE 1') fail(`ABORT: verifying ${email} reported "${out}", not "UPDATE 1"`)
  }

  return { apiUrl, webUrl, psql, verifyUser, stop, refuseDatabaseUrl }
}

/**
 * Takes a user's 15-minute page-open claim with a real `page_open` POST, so the next time
 * that user opens Transactions the page-open run is throttled and posts nothing. The POST
 * is itself a run of the posting job over the user's postable installments: call it BEFORE
 * the scenario creates its entries, or it posts their due months. `api(token, method, url,
 * body)` returns `{ status, json }` (the scripts' own helper); `user` carries `token`.
 * Returns the response. Throws unless it is a 200.
 */
async function consumePageOpen(api, user) {
  const res = await api(user.token, 'POST', '/budget-entries/post-due-installments', { trigger: 'page_open' })
  if (res.status !== 200) throw new Error(`consumePageOpen: ${res.status} ${JSON.stringify(res.json)}`)
  return res.json
}

module.exports = { startLocalStack, refuseDatabaseUrl, consumePageOpen }
