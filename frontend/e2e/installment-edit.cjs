// Browser check for STU-343 Plan B (B1): editing a capped recurring entry keeps its
// last payment, and a form opened from a stale copy cannot overwrite a newer one.
// Starts its own API and web app against a throwaway database
// (./_local_stack.cjs). Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Scenarios:
//   (a) moving a capped entry's next date forward two months keeps its last payment:
//       the API shows the count lowered by 2 and the offset raised by 2
//   (b) the form is opened, Mark paid runs through the API, and Save shows
//       "This entry changed since you opened it; reopen it to edit"; the API is
//       unchanged by the refused save, and the reopened form (no page reload) shows the
//       current entry and saves. The entry has never been saved before, so its version is null
//   (c) the edit form explains the count (the final-month help); the add form does not,
//       and neither does an open-ended entry's edit form switched to "After runs"
//   (d) a date after the plan's last payment is refused with the server's reason
//       inline, the form stays open, and changing the count too saves
//
// Every request-starting action is followed by waitQuiet(page) (the screen loader
// blocks input while a request is in flight; see ./README.md).
//
// Usage: node frontend/e2e/installment-edit.cjs [a|b|c|d]
const { startLocalStack } = require('./_local_stack.cjs')
const { waitQuiet } = require('./_smooth.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let pass = 0, total = 0
function check(what, actual, expected) {
  total++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// ─── Days (YYYY-MM-DD, UTC arithmetic) ───────────────────────────────────────
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** `day` moved by n months, on day-of-month `anchor`. Callers keep the anchor at 28 or less. */
const addMonths = (day, n, anchor = Number(day.slice(8, 10))) => {
  let y = Number(day.slice(0, 4))
  let m = Number(day.slice(5, 7)) + n
  while (m > 12) { m -= 12; y += 1 }
  while (m < 1) { m += 12; y -= 1 }
  return `${y}-${String(m).padStart(2, '0')}-${String(anchor).padStart(2, '0')}`
}
/** The first 15th that is at least three days ahead, so the entry is not due. */
const firstDate = () => {
  const today = manilaToday()
  const earliest = addDays(today, 3)
  const sameMonth = addMonths(today, 0, 15)
  return sameMonth >= earliest ? sameMonth : addMonths(today, 1, 15)
}
const wire = (day) => `${day}T00:00:00`

const FINAL_MONTH_HELP = 'Moving the next date keeps the last payment; change this number to lengthen or shorten the plan.'
const STALE = 'This entry changed since you opened it; reopen it to edit'

let stack, API
async function api(token, method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
async function post(token, url, body) {
  const r = await api(token, 'POST', url, body)
  if (r.status >= 300) throw new Error(`POST ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const get = async (token, url) => {
  const r = await api(token, 'GET', url)
  if (r.status >= 300) throw new Error(`GET ${url} ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

async function makeUser(tag) {
  const email = `e2e-ie-${tag}-${Math.random().toString(16).slice(2, 8)}@example.com`
  const password = 'E2eTest!2345'
  const reg = await api('', 'POST', '/auth/register', { email, password, first_name: `User${tag}`, last_name: 'Test', default_currency: 'PHP' })
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.json)}`)
  stack.verifyUser(email) // aborts the run unless psql reports UPDATE 1
  const login = await api('', 'POST', '/auth/login', { email, password })
  if (login.status !== 200) throw new Error(`login ${login.status}`)
  return { email, password, tag, token: login.json.access_token }
}

/** A capped monthly expense on a checking account: `count` payments from the first date. */
async function seed(u, count) {
  const bank = await post(u.token, '/accounts/', { name: `${u.tag} Checking`, account_type: 'checking', balance: 100000, currency: 'PHP' })
  const start = firstDate()
  const plan = await post(u.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Gadget plan', amount: 1500,
    account_id: bank.id, next_occurrence: wire(start), end_mode: 'after_occurrences', max_occurrences: count,
  })
  return { bank, plan, start }
}
const entryNow = (u, id) => get(u.token, `/budget-entries/${id}`)
const stored = (e) => ({ next: e.next_occurrence.slice(0, 10), max: e.max_occurrences, offset: e.occurrences_paid_offset })

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const page = await ctx.newPage()
  if (process.env.DEBUG) page.on('response', (r) => { if (r.url().includes('/api/v1/')) console.log(`    [net] ${r.request().method()} ${r.url().replace(API, '')} -> ${r.status()}`) })
  return { ctx, page }
}

async function uiLogin(page, u) {
  await page.goto(`${stack.webUrl}/login`)
  await page.locator('#email').fill(u.email)
  await page.locator('#password').fill(u.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL((url) => url.pathname === '/')
  await waitQuiet(page)
}

async function openAllocations(page) {
  await page.goto(`${stack.webUrl}/allocations`)
  await page.locator('[data-testid^="kind-section-"]').first().waitFor()
  await waitQuiet(page)
}

const entryCard = (page, name) => page.locator('article').filter({ has: page.getByText(name, { exact: true }) })
const planCard = (page) => entryCard(page, 'Gadget plan')
const modalClose = (page) => page.getByLabel('Close allocation modal')
const updateButton = (page) => page.getByRole('button', { name: 'Update Recurring Entry' })
const editForm = (page) => page.locator('form').filter({ has: updateButton(page) })
const nextInput = (form) => form.locator('input[type="datetime-local"]').first()
const runsInput = (form) => form.getByText('Number of runs', { exact: true }).locator('xpath=following-sibling::input')

async function openEdit(page, card = planCard(page)) {
  await card.click()
  await modalClose(page).waitFor()
  await waitQuiet(page)
  return editForm(page)
}

async function save(page) {
  await updateButton(page).click()
  await waitQuiet(page)
}

async function forwardTwoMonths(browser) {
  console.log('(a) moving the next date forward keeps the last payment')
  const me = await makeUser('a')
  const { plan, start } = await seed(me, 12)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const form = await openEdit(page)
  const moved = addMonths(start, 2)
  await nextInput(form).fill(`${moved}T00:00`)
  await save(page)
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  check('(a) the next date moved two months', stored(await entryNow(me, plan.id)), { next: moved, max: 10, offset: 2 })
  await ctx.close()
}

async function staleForm(browser) {
  console.log('(b) a form opened before Mark paid is refused on Save')
  const me = await makeUser('b')
  const { plan, start } = await seed(me, 6)
  check('(b) the entry has never been saved', (await entryNow(me, plan.id)).updated_at, null)
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const form = await openEdit(page)
  // Someone else (here, the API) records the first payment while the form is open.
  await post(me.token, `/budget-entries/${plan.id}/materialize`, {})
  const afterPaid = stored(await entryNow(me, plan.id))
  check('(b) Mark paid moved the entry on', afterPaid.next, addMonths(start, 1))
  await nextInput(form).fill(`${addMonths(start, 3)}T00:00`)
  await save(page)
  check('(b) Save shows the stale-copy reason', await page.getByTestId('recurring-save-error').innerText(), STALE)
  check('(b) the form is still open', await modalClose(page).count(), 1)
  check('(b) the refused save changed nothing', stored(await entryNow(me, plan.id)), afterPaid)
  // The refused save reloaded the entries, so reopening shows the current one without a page reload.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  const again = await openEdit(page)
  check('(b) the reopened form shows the current next date', await nextInput(again).inputValue(), `${afterPaid.next}T00:00`)
  await nextInput(again).fill(`${addMonths(start, 3)}T00:00`)
  await save(page)
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  check('(b) the reopened form saved', stored(await entryNow(me, plan.id)).next, addMonths(start, 3))
  await ctx.close()
}

async function help(browser) {
  console.log('(c) the final-month help')
  const me = await makeUser('c')
  const { bank } = await seed(me, 4)
  await post(me.token, '/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Streaming', amount: 500,
    account_id: bank.id, next_occurrence: wire(firstDate()), end_mode: 'indefinite',
  })
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const form = await openEdit(page)
  check('(c) the edit form explains the count', await form.getByTestId('final-month-help').innerText(), FINAL_MONTH_HELP)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  await modalClose(page).waitFor()
  await waitQuiet(page)
  const add = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
  check('(c) the add form has no final-month help', await add.getByTestId('final-month-help').count(), 0)
  await modalClose(page).click()
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  // An open-ended entry has no last payment to keep: switching its form to a count shows none.
  const openEnded = await openEdit(page, entryCard(page, 'Streaming'))
  await openEnded.getByRole('button', { name: 'After runs', exact: true }).click()
  check('(c) the open-ended entry now shows the count', await runsInput(openEnded).count(), 1)
  check('(c) the open-ended entry has no final-month help', await openEnded.getByTestId('final-month-help').count(), 0)
  await ctx.close()
}

async function pastFinal(browser) {
  console.log('(d) a date after the last payment is refused with the reason')
  const me = await makeUser('d')
  const { plan, start } = await seed(me, 3)
  const before = stored(await entryNow(me, plan.id))
  const { ctx, page } = await newPage(browser)
  await uiLogin(page, me)
  await openAllocations(page)
  const form = await openEdit(page)
  await nextInput(form).fill(`${addMonths(start, 6)}T00:00`)
  await save(page)
  const message = await page.getByTestId('recurring-save-error').innerText()
  check('(d) the reason names the last payment', message.startsWith("The new date is after the plan's last payment ("), true)
  check('(d) the reason asks for the count too', message.endsWith('change the number of payments too'), true)
  check('(d) the form is still open', await modalClose(page).count(), 1)
  check('(d) nothing was written', stored(await entryNow(me, plan.id)), before)
  await runsInput(form).fill('2')
  await save(page)
  await modalClose(page).waitFor({ state: 'detached' })
  await waitQuiet(page)
  const after = stored(await entryNow(me, plan.id))
  check('(d) the date and the count together are saved as sent', [after.next, after.max], [addMonths(start, 6), 2])
  await ctx.close()
}

;(async () => {
  stack = await startLocalStack()
  API = `${stack.apiUrl}/api/v1`
  const browser = await chromium.launch()
  const run = (k) => !only || only === k
  if (run('a')) await forwardTwoMonths(browser)
  if (run('b')) await staleForm(browser)
  if (run('c')) await help(browser)
  if (run('d')) await pastFinal(browser)
  await browser.close()
  stack.stop()
  console.log(`\nRESULT: ${pass}/${total} assertions passed`)
  process.exit(pass === total ? 0 : 1)
})().catch((e) => { console.error(e); stack?.stop(); console.log(`\nRESULT (aborted): ${pass}/${total} assertions passed`); process.exit(1) })
