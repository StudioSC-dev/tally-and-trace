// Browser checks for STU-605 (PERF-10): saves leave their dialog at once and run in the
// background through the save outbox, with stacked toasts and "Saving…" rows; no screen
// loader blocks for a save or a refetch.
//   (a) AC1 a held POST: dialog closed, pending toast and "Saving…" row, the page takes input
//       (another dialog opens); released → "Saved" and the row.
//   (b) AC2 three quick saves reach the server in creation order; their toasts stack.
//   (c) AC3 a 422 after the dialog closed: failed toast, no Retry; Edit reopens the form with
//       the typed values and the refusal shown inline.
//   (d) AC4 a network drop after the server committed (unknown outcome), then Retry: one row,
//       the same Idempotency-Key on both requests.
//   (e) AC5 move to Dashboard while the save is held; release; the toast turns "Saved" there,
//       and Transactions lists the row on return.
//   (f) AC6 reload during a held save: the draft returns as a failed "not confirmed" toast;
//       Retry creates one row.
//   (g) AC7 no zero flash: while the refetch after a save is held, the dashboard balances and
//       the Due figures keep their values, and the busy overlay never appears.
//   (h) AC8 a row with a pending edit is read-only ("Saving…", no action modal); Undo on a
//       created row deletes it.
//   (i) a pending delete dims its row; the stack folds past four toasts into "+N more".
//   (j) the Due card's Mark paid saves in the background: the dialog closes at once with its
//       POST held, a pending toast shows, the row's actions are disabled until it settles, the
//       request carries an Idempotency-Key; released → "Saved" and the row leaves Due.
//   (k) a refused Due-card Mark paid: failed toast with Edit; Edit reopens Mark paid with the
//       typed day and the server's reason; saving again records it once.
//   (l) a refused Due-card card payment: Edit reopens Pay with the typed amount and the reason.
// AC4 and AC6 need the API's Idempotency-Key support (STU-604) to hold: without it a retried
// create that had landed would make a second row.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI. Run steps: ./README.md. Condition waits only.
//
// Usage: node frontend/e2e/background-saves.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const { pick } = require('./_picker.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
const SHOTS = process.env.SHOTS_DIR || null

let stack, client

const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const wire = (day) => `${day}T00:00:00`
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/api/v1/transactions')
const tid = (id) => `[data-testid="${id}"]`
const text = async (locator) => ((await locator.textContent({ timeout: 3000 }).catch(() => null)) || '').replace(/\s+/g, ' ').trim()

const toasts = (page) => page.locator(tid('save-toast'))
const toastFor = (page, description) => toasts(page).filter({ hasText: description })
const rowFor = (page, description) => page.locator('article[data-transaction-id]').filter({ hasText: description })
const pendingRowFor = (page, description) => page.locator(tid('pending-row')).filter({ hasText: description })
const formOf = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: /^(Create|Update) Transaction$/ }) })

async function shot(page, name) {
  if (!SHOTS) return
  await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {})
}

async function seedUser(tag) {
  const user = await h.makeUser(stack, tag)
  const checking = await client.post(user.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 50000, currency: 'PHP' })
  return { user, checking }
}

/** Server rows with this description, read through the API. */
async function serverCount(user, description) {
  const list = await client.get(user.token, `/transactions/?search=${encodeURIComponent(description)}&limit=100`)
  return list.items.filter((t) => t.description === description).length
}

/** A fresh signed-in page on Transactions; `overlaySeen()` says whether a busy overlay ever showed. */
async function openPage(browser, user) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila' })
  page.setDefaultTimeout(10000)
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
  await page.addInitScript(() => {
    window.__overlaySeen = false
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="busy-overlay"]')
      if (el && el.getAttribute('data-phase') !== 'hidden') window.__overlaySeen = true
    }).observe(document, { subtree: true, childList: true, attributes: true })
  })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  const overlaySeen = () => page.evaluate(() => window.__overlaySeen === true)
  return { ctx, page, overlaySeen }
}

/** Fills the Create dialog with an expense on `accountName`. */
async function fillCreate(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const form = formOf(page)
  await form.waitFor()
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await pick(form.locator('[data-field="account_id"]'), accountName)
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill(String(amount))
  return form
}

async function createUI(page, opts) {
  const form = await fillCreate(page, opts)
  await form.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  return form
}

/** Waits until the toast for `description` is in `state` (pending, saved, failed); true on arrival. */
async function waitToast(page, description, state, ms = 10000) {
  try {
    await toastFor(page, description).and(page.locator(`[data-state="${state}"]`)).first().waitFor({ timeout: ms })
    return true
  } catch {
    return false
  }
}

// ─── (a) AC1 ─────────────────────────────────────────────────────────────────
async function scenarioA(browser) {
  console.log('\n(a) held save: dialog closed, toast and row, page takes input')
  const { user, checking } = await seedUser('bga')
  const { ctx, page, overlaySeen } = await openPage(browser, user)
  try {
    const held = await h.gate(page, isCreate)
    const form = await createUI(page, { accountName: checking.name, amount: 1234, description: 'BG A Lunch' })
    await h.check('a.post-held', 'S', async () => (await held.waitHits(1)) || 'no POST reached the hold')
    await h.check('a.dialog-closed', 'B', async () => (await form.isHidden()) || 'the dialog is still open')
    await h.check('a.pending-toast', 'B', async () => {
      const ok = await waitToast(page, '₱1,234.00', 'pending', 3000)
      return ok || `toasts: ${await text(page.locator(tid('toast-stack')))}`
    })
    await h.check('a.pending-label', 'B', async () => {
      const t = await text(toasts(page).first())
      return t.includes(`Saving ₱1,234.00 to ${checking.name}`) || `toast reads "${t}"`
    })
    await h.check('a.saving-row', 'B', async () => {
      const row = pendingRowFor(page, 'BG A Lunch')
      await row.waitFor({ timeout: 3000 })
      return (await row.getAttribute('data-state')) === 'saving' || 'row not in the saving state'
    })
    await shot(page, 'a-pending')
    await h.check('a.page-takes-input', 'B', async () => {
      await page.getByRole('button', { name: 'Add Transaction' }).first().click()
      const again = formOf(page)
      await again.waitFor({ timeout: 3000 })
      const input = again.locator('input[placeholder="Add notes about this transaction"]')
      await input.fill('typed while saving')
      const value = await input.inputValue()
      await again.getByRole('button', { name: 'Cancel', exact: true }).click()
      return value === 'typed while saving' || `typed value "${value}"`
    })
    held.release({ disarm: true })
    await h.check('a.saved', 'B', async () => (await waitToast(page, 'BG A Lunch', 'saved')) || 'no Saved toast')
    await shot(page, 'a-saved')
    await h.check('a.row-listed', 'B', async () => {
      await rowFor(page, 'BG A Lunch').first().waitFor({ timeout: 10000 })
      return (await pendingRowFor(page, 'BG A Lunch').count()) === 0 || 'the Saving… row stayed beside the server row'
    })
    await h.check('a.one-server-row', 'B', async () => ((await serverCount(user, 'BG A Lunch')) === 1) || 'server rows != 1')
    await h.check('a.no-overlay', 'B', async () => !(await overlaySeen()) || 'the busy overlay showed')
  } finally {
    await ctx.close()
  }
}

// ─── (b) AC2 ─────────────────────────────────────────────────────────────────
async function scenarioB(browser) {
  console.log('\n(b) three quick saves: in order, toasts stack')
  const { user, checking } = await seedUser('bgb')
  const { ctx, page } = await openPage(browser, user)
  try {
    const held = await h.gate(page, isCreate)
    const names = ['BG B First', 'BG B Second', 'BG B Third']
    for (const [i, description] of names.entries()) {
      await createUI(page, { accountName: checking.name, amount: 100 + i, description })
    }
    await h.check('b.one-in-flight', 'B', async () => {
      await held.waitHits(1)
      await h.sleep(0)
      return held.hits === 1 || `${held.hits} POSTs reached the server while the first was held`
    })
    await h.check('b.toasts-stack', 'B', async () => {
      const n = await toasts(page).count()
      return n === 3 || `${n} toasts`
    })
    await shot(page, 'b-stacked')
    held.release({ disarm: true })
    await h.check('b.all-saved', 'B', async () => {
      for (const description of names) if (!(await waitToast(page, description, 'saved'))) return `${description} not saved`
      return true
    })
    await h.check('b.creation-order', 'B', async () => {
      const sent = held.bodies.map((b) => JSON.parse(b).description)
      return JSON.stringify(sent) === JSON.stringify(names) || `sent ${JSON.stringify(sent)}`
    })
    await h.check('b.server-order', 'B', async () => {
      const ids = []
      for (const description of names) {
        const list = await client.get(user.token, `/transactions/?search=${encodeURIComponent(description)}`)
        ids.push(list.items[0].id)
      }
      return (ids[0] < ids[1] && ids[1] < ids[2]) || `ids ${ids}`
    })
  } finally {
    await ctx.close()
  }
}

// ─── (c) AC3 ─────────────────────────────────────────────────────────────────
async function scenarioC(browser) {
  console.log('\n(c) refused after close: failed toast, Edit reopens with input and error')
  const { user, checking } = await seedUser('bgc')
  const { ctx, page } = await openPage(browser, user)
  try {
    const reason = 'The amount is over this account\'s limit'
    await page.route((url) => url.pathname.endsWith('/api/v1/transactions/'), async (route, request) => {
      if (request.method() !== 'POST') return route.fallback()
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': request.headers().origin || '*', 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ detail: [{ loc: ['body', 'amount'], msg: reason, type: 'value_error' }] }),
      })
    })
    const form = await createUI(page, { accountName: checking.name, amount: 777, description: 'BG C Refused' })
    await h.check('c.dialog-closed', 'B', async () => (await form.isHidden()) || 'dialog still open')
    await h.check('c.failed-toast', 'B', async () => (await waitToast(page, 'BG C Refused', 'failed')) || 'no failed toast')
    const toast = toastFor(page, 'BG C Refused')
    await shot(page, 'c-failed')
    await h.check('c.message', 'B', async () => {
      const t = await text(toast.locator(tid('save-toast-message')))
      return t === `Couldn't save "BG C Refused": ${reason}` || `toast reads "${t}"`
    })
    await h.check('c.no-retry', 'B', async () => ((await toast.locator(tid('save-toast-retry')).count()) === 0) || 'Retry offered for a refusal')
    await h.check('c.row-failed', 'B', async () => {
      const row = pendingRowFor(page, 'BG C Refused')
      return ((await row.getAttribute('data-state', { timeout: 3000 })) === 'failed') || 'no failed row'
    })
    await toast.locator(tid('save-toast-edit')).click()
    const reopened = formOf(page)
    await h.check('c.reopened', 'B', async () => { await reopened.waitFor({ timeout: 3000 }); return true })
    await h.check('c.values-kept', 'B', async () => {
      const description = await reopened.locator('input[placeholder="Add notes about this transaction"]').inputValue()
      const amount = await reopened.locator('input[type="number"][placeholder="0.00"]').first().inputValue()
      return (description === 'BG C Refused' && Number(amount) === 777) || `description "${description}", amount "${amount}"`
    })
    await h.check('c.error-shown', 'B', async () => {
      const t = await text(reopened.locator(tid('transaction-form-error')))
      return t === reason || `form error "${t}"`
    })
    await shot(page, 'c-edit')
    await h.check('c.toast-gone', 'B', async () => ((await toastFor(page, 'BG C Refused').count()) === 0) || 'failed toast still shown')
    // The fixed save goes through: the refusal route is removed first.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await reopened.locator('input[type="number"][placeholder="0.00"]').first().fill('77')
    await reopened.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    await h.check('c.fixed-saved', 'B', async () => (await waitToast(page, 'BG C Refused', 'saved')) || 'fixed save not saved')
  } finally {
    await ctx.close()
  }
}

// ─── (d) AC4 ─────────────────────────────────────────────────────────────────
async function scenarioD(browser) {
  console.log('\n(d) unknown outcome then Retry: one row, same key')
  const { user, checking } = await seedUser('bgd')
  const { ctx, page } = await openPage(browser, user)
  try {
    const keys = []
    let dropped = 0
    await page.route((url) => url.pathname.endsWith('/api/v1/transactions/'), async (route, request) => {
      if (request.method() !== 'POST') return route.fallback()
      keys.push(request.headers()['idempotency-key'] || null)
      if (dropped === 0) {
        dropped++
        // The server commits; the answer never reaches the page.
        await route.fetch()
        return route.abort('connectionreset')
      }
      return route.fallback()
    })
    await createUI(page, { accountName: checking.name, amount: 450, description: 'BG D Dropped' })
    await h.check('d.failed-toast', 'B', async () => (await waitToast(page, 'BG D Dropped', 'failed')) || 'no failed toast')
    await h.check('d.server-has-it', 'S', async () => ((await serverCount(user, 'BG D Dropped')) === 1) || 'the first request did not commit')
    const toast = toastFor(page, 'BG D Dropped')
    await h.check('d.retry-offered', 'B', async () => ((await toast.locator(tid('save-toast-retry')).count()) === 1) || 'no Retry')
    await h.check('d.no-edit', 'B', async () => ((await toast.locator(tid('save-toast-edit')).count()) === 0) || 'Edit offered after an unknown outcome')
    await toast.locator(tid('save-toast-retry')).click()
    await h.check('d.saved', 'B', async () => (await waitToast(page, 'BG D Dropped', 'saved')) || 'no Saved toast')
    await h.check('d.same-key', 'B', () => (keys.length === 2 && keys[0] && keys[0] === keys[1]) || `keys ${JSON.stringify(keys)}`)
    await h.check('d.one-row', 'B', async () => {
      const n = await serverCount(user, 'BG D Dropped')
      return n === 1 || `${n} server rows`
    })
  } finally {
    await ctx.close()
  }
}

// ─── (e) AC5 ─────────────────────────────────────────────────────────────────
async function scenarioE(browser) {
  console.log('\n(e) move to Dashboard while held; Saved there; row on return')
  const { user, checking } = await seedUser('bge')
  const { ctx, page } = await openPage(browser, user)
  try {
    const held = await h.gate(page, isCreate)
    await createUI(page, { accountName: checking.name, amount: 222, description: 'BG E Away' })
    await held.waitHits(1)
    await page.getByRole('link', { name: 'Dashboard' }).first().click()
    await page.waitForURL((url) => url.pathname === '/')
    await h.check('e.pending-on-dashboard', 'B', async () => (await waitToast(page, '₱222.00', 'pending', 3000)) || 'no pending toast on Dashboard')
    held.release({ disarm: true })
    await h.check('e.saved-on-dashboard', 'B', async () => (await waitToast(page, 'BG E Away', 'saved')) || 'no Saved toast on Dashboard')
    await h.check('e.still-dashboard', 'S', () => new URL(page.url()).pathname === '/' || page.url())
    await page.getByRole('link', { name: 'Transactions' }).first().click()
    await h.check('e.row-on-return', 'B', async () => { await rowFor(page, 'BG E Away').first().waitFor({ timeout: 10000 }); return true })
  } finally {
    await ctx.close()
  }
}

// ─── (f) AC6 ─────────────────────────────────────────────────────────────────
async function scenarioF(browser) {
  console.log('\n(f) reload during a held save: not confirmed, Retry makes one row')
  const { user, checking } = await seedUser('bgf')
  const { ctx, page } = await openPage(browser, user)
  try {
    const keys = []
    page.on('request', (r) => { if (isCreate(r)) keys.push(r.headers()['idempotency-key'] || null) })
    const held = await h.gate(page, isCreate)
    await createUI(page, { accountName: checking.name, amount: 333, description: 'BG F Reloaded' })
    await held.waitHits(1)
    await page.reload()
    // The held request from the old document is let through now: it may land (unknown outcome).
    held.release({ disarm: true })
    await h.check('f.not-confirmed', 'B', async () => (await waitToast(page, 'BG F Reloaded', 'failed')) || 'no failed toast after reload')
    const toast = toastFor(page, 'BG F Reloaded')
    await shot(page, 'f-not-confirmed')
    await h.check('f.message', 'B', async () => {
      const t = await text(toast.locator(tid('save-toast-message')))
      return t.includes('Not confirmed — Retry or Discard') || `toast reads "${t}"`
    })
    await toast.locator(tid('save-toast-retry')).click()
    await h.check('f.saved', 'B', async () => (await waitToast(page, 'BG F Reloaded', 'saved')) || 'no Saved toast')
    await h.check('f.same-key', 'B', () => (keys.length >= 2 && keys.every((k) => k && k === keys[0])) || `keys ${JSON.stringify(keys)}`)
    await h.check('f.one-row', 'B', async () => {
      const n = await serverCount(user, 'BG F Reloaded')
      return n === 1 || `${n} server rows`
    })
  } finally {
    await ctx.close()
  }
}

// ─── (g) AC7 ─────────────────────────────────────────────────────────────────
async function scenarioG(browser) {
  console.log('\n(g) no zero flash while the refetch after a save is held')
  const { user, checking } = await seedUser('bgg')
  await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'BG G Rent', amount: 1500,
    account_id: checking.id, next_occurrence: wire(manilaToday()),
  })
  const { ctx, page, overlaySeen } = await openPage(browser, user)
  try {
    await page.locator(tid('due-amount')).first().waitFor()
    const dueBefore = await text(page.locator(tid('due-section')))
    // Hold every refetch the save's drain starts (reads only; the POST itself goes through).
    const reads = await h.holdResponse(page, (r) => r.method() === 'GET' && r.url().includes('/api/v1/'))
    await createUI(page, { accountName: checking.name, amount: 50, description: 'BG G Coffee' })
    await h.check('g.refetch-held', 'S', async () => (await reads.waitHits(1, 10000)) || 'no refetch after the save')
    const samples = []
    for (let i = 0; i < 10; i++) {
      samples.push(await text(page.locator(tid('due-section'))))
      await h.sleep(30)
    }
    await h.check('g.due-kept', 'B', () => samples.every((t) => t === dueBefore) || `Due changed while held: ${samples.find((t) => t !== dueBefore)}`)
    await h.check('g.due-not-zero', 'B', () => samples.every((t) => t !== '' && t.includes('₱1,500.00')) || 'Due lost its figure')
    reads.release({ disarm: true })
    await waitToast(page, 'BG G Coffee', 'saved')
    // Balances: on the dashboard, with a save from Transactions draining while its reads are held.
    await page.getByRole('link', { name: 'Dashboard' }).first().click()
    await page.locator(tid('quick-balances')).waitFor()
    await page.locator(tid('quick-balance-tile')).first().waitFor()
    const tilesBefore = await text(page.locator(tid('quick-balances')))
    await page.getByRole('link', { name: 'Transactions' }).first().click()
    const post = await h.gate(page, isCreate)
    await createUI(page, { accountName: checking.name, amount: 60, description: 'BG G Tea' })
    await post.waitHits(1)
    await page.getByRole('link', { name: 'Dashboard' }).first().click()
    await page.locator(tid('quick-balance-tile')).first().waitFor()
    const again = await h.holdResponse(page, (r) => r.method() === 'GET' && r.url().includes('/api/v1/'))
    post.release({ disarm: true })
    await h.check('g.dash-refetch-held', 'S', async () => (await again.waitHits(1, 10000)) || 'no dashboard refetch')
    const tiles = []
    for (let i = 0; i < 10; i++) {
      tiles.push(await text(page.locator(tid('quick-balances'))))
      await h.sleep(30)
    }
    await h.check('g.balances-kept', 'B', () => tiles.every((t) => t === tilesBefore) || `balances changed while held: "${tiles.find((t) => t !== tilesBefore)}" vs "${tilesBefore}"`)
    await h.check('g.balances-not-zero', 'B', () => tiles.every((t) => !t.includes('₱0.00') && t !== '') || 'a balance read ₱0.00 or empty')
    again.release({ disarm: true })
    await h.check('g.no-overlay', 'B', async () => !(await overlaySeen()) || 'the busy overlay showed')
  } finally {
    await ctx.close()
  }
}

// ─── (h) AC8 ─────────────────────────────────────────────────────────────────
async function scenarioH(browser) {
  console.log('\n(h) a pending edit makes its row read-only; Undo removes a created row')
  const { user, checking } = await seedUser('bgh')
  await client.post(user.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 90, currency: 'PHP', description: 'BG H Existing',
    transaction_date: wire(manilaToday()), is_posted: true,
  })
  const { ctx, page } = await openPage(browser, user)
  try {
    const row = rowFor(page, 'BG H Existing').first()
    await row.click()
    await page.getByRole('heading', { name: 'Transaction Actions' }).waitFor()
    await page.getByRole('button', { name: /^Edit/ }).first().click()
    const form = formOf(page)
    await form.waitFor()
    const held = await h.gate(page, (r) => r.method() === 'PUT' && /\/api\/v1\/transactions\/\d+$/.test(pathOf(r.url())))
    await form.locator('input[placeholder="Add notes about this transaction"]').fill('BG H Edited')
    await form.getByRole('button', { name: 'Update Transaction', exact: true }).click()
    await held.waitHits(1)
    const pendingRow = page.locator('article[data-transaction-id][data-pending="update"]')
    await h.check('h.row-marked', 'B', async () => { await pendingRow.waitFor({ timeout: 3000 }); return (await text(pendingRow.locator(tid('row-saving')))) === 'Saving…' || 'no Saving… badge' })
    await shot(page, 'h-row-saving')
    await h.check('h.row-read-only', 'B', async () => {
      await pendingRow.click({ force: true })
      return (await h.expectAbsentFor(page, page.getByRole('heading', { name: 'Transaction Actions' }), 500)) || 'the action modal opened'
    })
    held.release({ disarm: true })
    await h.check('h.edit-saved', 'B', async () => (await waitToast(page, 'BG H Edited', 'saved')) || 'no Saved toast')
    await h.check('h.row-free', 'B', async () => { await page.locator('article[data-transaction-id]:not([data-pending])').filter({ hasText: 'BG H Edited' }).waitFor({ timeout: 10000 }); return true })

    await createUI(page, { accountName: checking.name, amount: 12, description: 'BG H Undo me' })
    await h.check('h.created', 'B', async () => (await waitToast(page, 'BG H Undo me', 'saved')) || 'no Saved toast')
    await h.check('h.undo', 'B', async () => {
      await toastFor(page, 'BG H Undo me').locator(tid('save-toast-undo')).click()
      await toastFor(page, 'Deleted "BG H Undo me"').and(page.locator('[data-state="saved"]')).waitFor({ timeout: 10000 })
      return true
    })
    await h.check('h.undo-gone', 'B', async () => {
      const n = await serverCount(user, 'BG H Undo me')
      if (n !== 0) return `${n} server rows`
      await rowFor(page, 'BG H Undo me').first().waitFor({ state: 'detached', timeout: 10000 })
      return true
    })
  } finally {
    await ctx.close()
  }
}

// ─── (i) delete dims, the stack folds ────────────────────────────────────────
async function scenarioI(browser) {
  console.log('\n(i) a pending delete dims its row; five toasts fold into +1 more')
  const { user, checking } = await seedUser('bgi')
  await client.post(user.token, '/transactions/', {
    account_id: checking.id, transaction_type: 'debit', amount: 40, currency: 'PHP', description: 'BG I Delete me',
    transaction_date: wire(manilaToday()), is_posted: true,
  })
  const { ctx, page } = await openPage(browser, user)
  try {
    const held = await h.gate(page, (r) => r.method() === 'DELETE')
    await rowFor(page, 'BG I Delete me').first().click()
    await page.getByRole('heading', { name: 'Transaction Actions' }).waitFor()
    await page.getByRole('button', { name: /^Delete/ }).first().click()
    await page.getByRole('button', { name: 'Delete transaction', exact: true }).click()
    await held.waitHits(1)
    const dimmed = page.locator('article[data-transaction-id][data-pending="delete"]')
    await h.check('i.row-dimmed', 'B', async () => {
      await dimmed.waitFor({ timeout: 3000 })
      const cls = (await dimmed.getAttribute('class')) || ''
      return (cls.includes('opacity-50') && (await text(dimmed.locator(tid('row-saving')))) === 'Deleting…') || `class "${cls}"`
    })
    // Four creates queue behind the held delete: five toasts, four shown.
    for (let i = 0; i < 4; i++) await createUI(page, { accountName: checking.name, amount: 10 + i, description: `BG I Queue ${i}` })
    await h.check('i.folded', 'B', async () => {
      const shown = await toasts(page).count()
      const more = await text(page.locator(tid('toast-more')))
      return (shown === 4 && more === '+1 more') || `shown ${shown}, more "${more}"`
    })
    await shot(page, 'i-folded')
    held.release({ disarm: true })
    await h.check('i.drained', 'B', async () => {
      for (let i = 0; i < 4; i++) if (!(await waitToast(page, `BG I Queue ${i}`, 'saved'))) return `Queue ${i} not saved`
      return (await serverCount(user, 'BG I Delete me')) === 0 || 'not deleted'
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioJ(browser) {
  console.log('\n(j) Due card Mark paid: background save, row actions wait')
  const { user, checking } = await seedUser('bgj')
  const entry = await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'BG J Rent', amount: 1500,
    account_id: checking.id, next_occurrence: wire(manilaToday()),
  })
  const { ctx, page, overlaySeen } = await openPage(browser, user)
  try {
    const isMaterialize = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith(`/budget-entries/${entry.id}/materialize`)
    const keys = []
    page.on('request', (r) => { if (isMaterialize(r)) keys.push(r.headers()['idempotency-key'] || null) })
    const dueRow = page.locator(tid('due-row')).filter({ hasText: 'BG J Rent' })
    const markPaid = dueRow.locator(tid('due-mark-paid'))
    await markPaid.click()
    const dialog = page.locator(tid('mark-paid-dialog'))
    await page.locator(`${tid('mark-paid-dialog')} ${tid('mark-paid-occurrence')}`).waitFor()
    const held = await h.gate(page, isMaterialize)
    await dialog.locator(tid('mark-paid-submit')).click()
    await h.check('j.post-held', 'S', async () => (await held.waitHits(1)) || 'no materialize POST reached the hold')
    await h.check('j.dialog-closed', 'B', async () => (await dialog.count()) === 0 || 'the Mark paid dialog is still open')
    await h.check('j.pending-toast', 'B', async () => (await waitToast(page, 'BG J Rent', 'pending', 3000)) || 'no pending toast')
    await h.check('j.row-actions-wait', 'B', async () => (await markPaid.isDisabled()) || 'Mark paid is still enabled while its save is queued')
    await h.check('j.idempotency-key', 'B', () => (keys.length === 1 && typeof keys[0] === 'string' && keys[0].length > 0) || `keys ${JSON.stringify(keys)}`)
    await shot(page, 'j-due-pending')
    held.release({ disarm: true })
    await h.check('j.saved', 'B', async () => (await waitToast(page, 'BG J Rent', 'saved')) || 'no Saved toast')
    await h.check('j.row-gone', 'B', async () => {
      try { await dueRow.waitFor({ state: 'detached', timeout: 10000 }); return true } catch { return 'the Due row stayed' }
    })
    await h.check('j.one-posted', 'B', async () => {
      const list = await client.get(user.token, '/transactions/?limit=100')
      const rows = list.items.filter((t) => t.budget_entry_id === entry.id)
      return rows.length === 1 || `server rows ${rows.length}`
    })
    await h.check('j.no-overlay', 'B', async () => !(await overlaySeen()) || 'the busy overlay showed')
  } finally {
    await ctx.close()
  }
}

async function scenarioK(browser) {
  console.log('\n(k) refused Due Mark paid: Edit reopens it with the typed day and the reason')
  const { user, checking } = await seedUser('bgk')
  const entry = await client.post(user.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'BG K Rent', amount: 1500,
    account_id: checking.id, next_occurrence: wire(manilaToday()),
  })
  const { ctx, page } = await openPage(browser, user)
  try {
    const isMaterialize = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith(`/budget-entries/${entry.id}/materialize`)
    const dueRow = page.locator(tid('due-row')).filter({ hasText: 'BG K Rent' })
    await dueRow.locator(tid('due-mark-paid')).click()
    const dialog = page.locator(tid('mark-paid-dialog'))
    await dialog.locator(tid('mark-paid-occurrence')).waitFor()
    const typedDay = addDays(manilaToday(), -1)
    await dialog.locator(tid('mark-paid-date')).fill(typedDay)
    const refused = await h.failWith(page, isMaterialize, 422, { times: 1 })
    await dialog.locator(tid('mark-paid-submit')).click()
    await h.check('k.dialog-closed', 'B', async () => {
      try { await dialog.waitFor({ state: 'detached', timeout: 3000 }); return true } catch { return 'Mark paid stayed open' }
    })
    await h.check('k.failed-toast', 'B', async () => (await waitToast(page, 'BG K Rent', 'failed')) || 'no failed toast')
    const toast = toastFor(page, 'BG K Rent')
    await h.check('k.no-retry', 'B', async () => (await toast.locator(tid('save-toast-retry')).count()) === 0 || 'Retry offered for a refusal')
    await h.check('k.edit-offered', 'B', async () => (await toast.locator(tid('save-toast-edit')).count()) === 1 || 'no Edit on the refused Mark paid')
    await shot(page, 'k-due-refused')
    await toast.locator(tid('save-toast-edit')).click().catch(() => {})
    await h.check('k.reopened', 'B', async () => {
      try { await dialog.locator(tid('mark-paid-occurrence')).waitFor({ timeout: 5000 }); return true } catch { return 'Mark paid did not reopen' }
    })
    await h.check('k.day-kept', 'B', async () => {
      const v = await dialog.locator(tid('mark-paid-date')).inputValue().catch(() => null)
      return v === typedDay || `date reads ${v}, typed ${typedDay}`
    })
    await h.check('k.reason-shown', 'B', async () => {
      const t = await text(dialog.locator(tid('mark-paid-error')))
      return t.includes('injected failure 422') || `error reads "${t}"`
    })
    await h.check('k.toast-gone', 'B', async () => (await toast.count()) === 0 || 'the failed toast stayed after Edit')
    await refused.stop()
    await dialog.locator(tid('mark-paid-submit')).click().catch(() => {})
    await h.check('k.saved', 'B', async () => (await waitToast(page, 'BG K Rent', 'saved')) || 'no Saved toast after the second save')
    await h.check('k.one-posted', 'B', async () => {
      const list = await client.get(user.token, '/transactions/?limit=100')
      const rows = list.items.filter((t) => t.budget_entry_id === entry.id)
      return (rows.length === 1 && rows[0].transaction_date.startsWith(typedDay)) || `server rows ${JSON.stringify(rows.map((t) => t.transaction_date))}`
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioL(browser) {
  console.log('\n(l) refused Due card payment: Edit reopens Pay with the typed amount and the reason')
  const { user, checking } = await seedUser('bgl')
  const today = manilaToday()
  const anchor = addDays(today, -5)
  const closeDom = Math.min(Number(anchor.slice(8, 10)), 28)
  const close = `${anchor.slice(0, 8)}${String(closeDom).padStart(2, '0')}`
  const presets = await client.get(user.token, '/accounts/minimum-due-presets')
  const card = await client.post(user.token, '/accounts/', {
    name: 'BG L Card', account_type: 'credit', balance: 0, currency: 'PHP', credit_limit: 50000,
    billing_cycle_start: closeDom, days_until_due_date: 21, minimum_due_rule: presets.find((p) => p.key === 'bdo').rule,
    payment_account_id: checking.id,
  })
  await client.post(user.token, '/transactions/', {
    account_id: card.id, transaction_type: 'debit', amount: 2000, description: 'BG L purchase',
    transaction_date: wire(addDays(close, -3)), is_posted: true,
  })
  const { ctx, page } = await openPage(browser, user)
  try {
    const isPay = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith(`/cards/${card.id}/payments`)
    const dueRow = page.locator(tid('due-row')).filter({ hasText: 'BG L Card' })
    await dueRow.locator(tid('due-pay')).click()
    const dialog = page.locator(tid('card-pay-dialog'))
    await dialog.locator(tid('card-pay-amount')).waitFor()
    await dialog.locator(tid('card-pay-amount')).fill('1234.5')
    const refused = await h.failWith(page, isPay, 422, { times: 1 })
    await dialog.locator(tid('card-pay-submit')).click()
    await h.check('l.dialog-closed', 'B', async () => {
      try { await dialog.waitFor({ state: 'detached', timeout: 3000 }); return true } catch { return 'Pay stayed open' }
    })
    await h.check('l.failed-toast', 'B', async () => (await waitToast(page, 'BG L Card', 'failed')) || 'no failed toast')
    const toast = toastFor(page, 'BG L Card')
    await h.check('l.edit-offered', 'B', async () => (await toast.locator(tid('save-toast-edit')).count()) === 1 || 'no Edit on the refused payment')
    await toast.locator(tid('save-toast-edit')).click().catch(() => {})
    await h.check('l.reopened', 'B', async () => {
      try { await dialog.locator(tid('card-pay-amount')).waitFor({ timeout: 5000 }); return true } catch { return 'Pay did not reopen' }
    })
    await h.check('l.amount-kept', 'B', async () => {
      const v = await dialog.locator(tid('card-pay-amount')).inputValue().catch(() => null)
      return v === '1234.5' || `amount reads ${v}`
    })
    await h.check('l.reason-shown', 'B', async () => {
      const t = await text(dialog.locator(tid('card-pay-error')))
      return t.includes('injected failure 422') || `error reads "${t}"`
    })
    await shot(page, 'l-card-pay-edit')
    await refused.stop()
  } finally {
    await ctx.close()
  }
}

const SCENARIOS = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE, f: scenarioF, g: scenarioG, h: scenarioH, i: scenarioI, j: scenarioJ, k: scenarioK, l: scenarioL }

async function main() {
  try {
    stack = await startLocalStack()
    client = h.apiClient(stack)
  } catch (error) {
    console.error(`SETUP FAILED: ${error && error.message ? error.message : error}`)
    process.exit(2)
  }
  const browser = await chromium.launch()
  let code = 1
  try {
    for (const [name, run] of Object.entries(SCENARIOS)) {
      if (only && only !== name) continue
      try {
        await run(browser)
      } catch (error) {
        await h.check(`${name}.ran`, 'S', () => `threw ${error && error.stack ? error.stack : error}`)
      }
    }
    code = h.report()
  } finally {
    await browser.close()
    await stack.stop()
  }
  process.exit(code)
}

main()
