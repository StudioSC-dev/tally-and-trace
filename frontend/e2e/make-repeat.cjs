// Browser checks for STU-585: "Make this repeat" in the Edit Transaction dialog. A saved
// transaction becomes the first occurrence of a new recurring entry, with the dialog's edits,
// in one request (POST /transactions/{id}/repeat) that replaces the PUT.
//
// (a) who sees it: the owner's own posted debit shows "Make this repeat", unchecked (Add still
//     reads "Repeat"); a transfer, a linked row and a row switched to Transfer show no toggle;
//     an editor sees none on the owner's joint row but does on their own row there; a viewer
//     has no Edit;
// (b) the schedule fields: Weekly and Every 2 weeks offered, no Semi-monthly; the day rule,
//     end date and count; the preview starts from the row's date and follows a date edit;
// (c) Update with an edited description and amount, monthly: exactly one write, a POST to
//     /transactions/{id}/repeat with no budget_entry_id and no PUT; the dialog closes, one row
//     carries the new description, the entry's next date is after the row's and the row is
//     linked to it;
// (d) the row then reads "Name • Monthly", the Scheduled view lists the entry's next date,
//     and Edit shows the link select on the entry and no toggle, also after picking "None";
// (e) a refused save (autopay over a past date) comes back as a failed toast whose Edit
//     reopens the form (STU-605: saves run in the background) with the server's reason on
//     the form's line, and changes nothing; a refused `settlement` shows under its control with aria-invalid,
//     aria-describedby and focus, a refused description under Description; a 404
//     "Transaction not found" stays on the form's line with no Retry; an API without the
//     endpoint (bare 404 "Not Found") shows the Edit copy with Retry, and Retry saves;
// (f) at 390px the Repeat fieldset has no horizontal scroll and its targets are 44px tall.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/make-repeat.cjs [a|b|c|e|f]   ((d) reads the row (c) saved, so runs with c)
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]
let stack, client

const AUTOPAY_REASON = 'Turn autopay on from the recurring entry, where you confirm the payments it would post'
const EDIT_UNAVAILABLE = "Repeat isn't available right now; the app may be updating. Try again, or turn Make this repeat off to save your changes."
const pad = (n) => String(n).padStart(2, '0')
/** The browser's local day (the browser runs in this process's time zone), `offset` days from today. */
const day = (offset = 0) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
const wire = (offset) => `${day(offset)}T00:00:00`

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const toggle = (modal) => modal.locator('[data-testid="repeat-toggle"]')
const toggleLabel = (modal) => modal.locator('[data-testid="repeat-section"] label').first()
const fields = (modal) => modal.locator('[data-testid="repeat-fields"]')
const repeatControl = (modal, key) => fields(modal).locator(`[data-field="${key}"]`)
const preview = (modal) => fields(modal).locator('[data-testid="schedule-preview"]')
const linkSelect = (modal) => modal.locator('select:has(> option[value=""])')
const rowsFor = (page, description) => page.locator('article[role="button"]').filter({ hasText: description })
const rowFor = (page, description) => rowsFor(page, description).first()
// Sign-in and token refreshes are not the dialog's writes.
const isApiWrite = (r) => r.method() !== 'GET' && r.method() !== 'OPTIONS' && r.url().includes('/api/v1/') && !r.url().includes('/api/v1/auth/')
const pathOf = (r) => new URL(r.url()).pathname.replace(/^\/api\/v1/, '').replace(/\/$/, '')
const isRepeatPost = (r) => r.request().method() === 'POST' && /\/transactions\/\d+\/repeat$/.test(new URL(r.url()).pathname)

async function account(user, name, type = 'checking', extra = {}) {
  return client.post(user.token, '/accounts/', { name, account_type: type, balance: 100000, currency: 'PHP', ...extra })
}
/** A debit through the API, posted on `offset` days from today unless `extra` says otherwise. */
const seed = (user, bank, description, extra = {}) =>
  client.post(user.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 250, currency: 'PHP', description,
    transaction_date: wire(0), is_posted: true, ...extra,
  })
const entriesNamed = async (user, name) => {
  const entries = await client.get(user.token, '/budget-entries/?limit=100')
  return (entries.items ?? entries).filter((e) => e.name === name)
}

/** `ready` is what the page shows once loaded: Add Transaction, or (a viewer with no account of their own has none) a row. */
async function openPage(browser, user, contextOptions = {}, ready = (page) => page.getByRole('button', { name: 'Add Transaction' }).first()) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const writes = []
  page.on('request', (r) => { if (isApiWrite(r)) writes.push({ method: r.method(), path: pathOf(r), body: r.postDataJSON() }) })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await ready(page).waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, writes }
}

/** Opens a row's Transaction Actions modal. */
async function openActions(page, description) {
  const row = rowFor(page, description)
  await row.waitFor()
  await h.waitQuiet(page)
  await row.click()
  const actions = formModal(page, 'Transaction Actions')
  await actions.waitFor()
  await h.waitQuiet(page)
  return actions
}

async function openEdit(page, description) {
  const actions = await openActions(page, description)
  await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
  const modal = formModal(page, 'Edit Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

async function cancel(page, modal) {
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await modal.waitFor({ state: 'detached' })
  await h.waitQuiet(page)
}

/** Answers the next make-repeat POST with `status` and a JSON `body`, without reaching the server. */
async function answerRepeat(page, status, body) {
  const state = { hits: 0 }
  await page.route((url) => /\/transactions\/\d+\/repeat$/.test(url.pathname), async (route, request) => {
    state.hits++
    const origin = request.headers().origin
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': origin || '*', ...(origin ? { 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}) },
      body: JSON.stringify(body),
    })
  }, { times: 1 })
  return state
}

/** Clicks Update Transaction and waits for the make-repeat POST it sends; returns its response. */
async function update(page, modal) {
  const [response] = await Promise.all([
    page.waitForResponse(isRepeatPost),
    modal.getByRole('button', { name: 'Update Transaction', exact: true }).click(),
  ])
  return response
}

// (a) Who is offered "Make this repeat".
async function scenarioA(browser) {
  console.log('\n=== (a) the owner\'s own row offers "Make this repeat"; transfers, linked rows and others\' rows do not')
  const owner = await h.makeUser(stack, 'mra')
  const editor = await h.makeUser(stack, 'mrae')
  const viewer = await h.makeUser(stack, 'mrav')
  const bank = await account(owner, 'MR Joint')
  const savings = await account(owner, 'MR Savings', 'savings')
  await client.post(owner.token, `/accounts/${bank.id}/shares`, { email: editor.email, role: 'editor' })
  await client.post(owner.token, `/accounts/${bank.id}/shares`, { email: viewer.email, role: 'viewer' })
  await seed(owner, bank, 'MR Coffee')
  await client.post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'transfer', amount: 500, currency: 'PHP', description: 'MR Move',
    transaction_date: wire(0), is_posted: true, transfer_from_account_id: bank.id, transfer_to_account_id: savings.id,
  })
  await client.post(owner.token, '/transactions/repeating', {
    transaction: {
      account_id: bank.id, transaction_type: 'debit', amount: 199, currency: 'PHP', description: 'MR Linked',
      transaction_date: wire(0), is_posted: true,
    },
    repeat: { cadence: 'monthly', anchor_day: Number(day(0).slice(8)), day_rule: null, end_mode: 'indefinite', billing_kind: null, settlement: 'manual' },
  })
  await seed(editor, bank, 'MR Editor own')

  {
    const { ctx, page, native, writes } = await openPage(browser, owner)
    try {
      await page.getByRole('button', { name: 'Add Transaction' }).first().click()
      let modal = formModal(page, 'Create Transaction')
      await modal.waitFor()
      await h.check('a.add-label-repeat', 'S', async () => (await toggleLabel(modal).innerText()).trim() === 'Repeat' || `label ${JSON.stringify(await toggleLabel(modal).innerText())}`)
      await cancel(page, modal)

      modal = await openEdit(page, 'MR Coffee')
      await h.check('a.owner-row-offered', 'B', async () => {
        const label = (await toggleLabel(modal).innerText()).trim()
        return (label === 'Make this repeat' && !(await toggle(modal).isChecked()) && !(await toggle(modal).isDisabled())) ||
          `label ${JSON.stringify(label)}, checked ${await toggle(modal).isChecked()}`
      })
      await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
      await h.check('a.switched-to-transfer-hidden', 'B', async () => {
        await toggle(modal).waitFor({ state: 'detached', timeout: 5000 })
        return true
      })
      await modal.getByRole('button', { name: 'Expense', exact: true }).click()
      await h.check('a.switched-back-offered', 'B', async () => {
        await toggle(modal).waitFor({ timeout: 5000 })
        return true
      })
      await cancel(page, modal)

      modal = await openEdit(page, 'MR Move')
      await h.check('a.transfer-no-toggle', 'B', async () => (await toggle(modal).count()) === 0 || 'toggle on a transfer')
      await cancel(page, modal)

      modal = await openEdit(page, 'MR Linked')
      await h.check('a.linked-no-toggle', 'B', async () => (await toggle(modal).count()) === 0 || 'toggle on a linked row')
      await cancel(page, modal)
      await h.check('a.nothing-written', 'G', async () => writes.length === 0 || `writes ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`)
    } finally {
      await d.checkNoNativeDialogs(h, 'a.owner', native)
      await ctx.close()
    }
  }
  {
    const { ctx, page, native } = await openPage(browser, editor)
    try {
      let modal = await openEdit(page, 'MR Coffee')
      await h.check('a.editor-on-owners-row-no-toggle', 'B', async () => (await toggle(modal).count()) === 0 || 'toggle on the owner\'s row')
      await cancel(page, modal)
      modal = await openEdit(page, 'MR Editor own')
      await h.check('a.editor-own-row-offered', 'B', async () =>
        ((await toggleLabel(modal).innerText()).trim() === 'Make this repeat') || 'no toggle on the editor\'s own row')
      await cancel(page, modal)
    } finally {
      await d.checkNoNativeDialogs(h, 'a.editor', native)
      await ctx.close()
    }
  }
  {
    const { ctx, page, native } = await openPage(browser, viewer, {}, (p) => rowFor(p, 'MR Coffee'))
    try {
      const actions = await openActions(page, 'MR Coffee')
      await h.check('a.viewer-no-edit', 'B', async () =>
        (await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).count()) === 0 || 'viewer has Edit')
    } finally {
      await d.checkNoNativeDialogs(h, 'a.viewer', native)
      await ctx.close()
    }
  }
}

// (b) The schedule fields and the preview.
async function scenarioB(browser) {
  console.log('\n=== (b) the schedule fields; the preview starts from the row\'s date and follows it')
  const user = await h.makeUser(stack, 'mrb')
  const bank = await account(user, 'MRB Checking')
  await seed(user, bank, 'MRB Rent')
  const { ctx, page, native, writes } = await openPage(browser, user)
  try {
    const modal = await openEdit(page, 'MRB Rent')
    await toggle(modal).check()
    await fields(modal).waitFor()
    await h.check('b.cadences', 'B', async () => {
      const values = await repeatControl(modal, 'cadence').locator('option').evaluateAll((os) => os.map((o) => o.value))
      return (values.includes('monthly') && values.includes('weekly') && values.includes('biweekly') && !values.includes('semi_monthly')) || `cadences ${JSON.stringify(values)}`
    })
    await h.check('b.day-rule-shown', 'S', async () => (await repeatControl(modal, 'day').count()) === 1 || 'no day control')
    await fields(modal).getByRole('button', { name: 'On date', exact: true }).click()
    await h.check('b.end-date-shown', 'S', async () => {
      await repeatControl(modal, 'end_date').waitFor({ timeout: 5000 })
      return true
    })
    await fields(modal).getByRole('button', { name: 'After runs', exact: true }).click()
    await h.check('b.count-shown', 'S', async () => {
      await repeatControl(modal, 'max_occurrences').waitFor({ timeout: 5000 })
      return true
    })
    await h.check('b.preview-from-row-date', 'B', async () => {
      const text = (await preview(modal).innerText()).trim()
      return text.startsWith(`Monthly · day ${Number(day(0).slice(8))}`) || `preview ${JSON.stringify(text)}`
    })
    const moved = day(-3)
    await control(modal, 'transaction_date').fill(moved)
    await h.check('b.preview-follows-date', 'B', async () => {
      const want = `Monthly · day ${Number(moved.slice(8))}`
      await preview(modal).filter({ hasText: want }).waitFor({ timeout: 5000 })
      return (await preview(modal).innerText()).trim().startsWith(want) || `preview ${JSON.stringify(await preview(modal).innerText())}`
    })
    await cancel(page, modal)
    await h.check('b.nothing-written', 'G', async () => writes.length === 0 || `writes ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) + (d) Saving with the toggle on, then how the linked row reads.
async function scenarioC(browser) {
  console.log('\n=== (c) Update with Make this repeat on: one POST /transactions/{id}/repeat, no PUT; (d) the row is then linked')
  const user = await h.makeUser(stack, 'mrc')
  const bank = await account(user, 'MRC Checking')
  const txn = await seed(user, bank, 'MRC Gym')
  const name = 'MRC Gym monthly'
  const { ctx, page, native, writes } = await openPage(browser, user)
  try {
    let modal = await openEdit(page, 'MRC Gym')
    await control(modal, 'description').fill(name)
    await control(modal, 'amount').fill('1500')
    await toggle(modal).check()
    await fields(modal).waitFor()
    await h.check('c.link-select-hidden', 'B', async () => (await modal.getByText('Recurring entry (optional)', { exact: true }).count()) === 0 || 'link select shown')
    writes.length = 0
    const response = await update(page, modal)
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('c.created-201', 'B', async () => response.status() === 201 || `status ${response.status()} ${await response.text()}`)
    await h.check('c.one-write-repeat-post', 'B', async () => {
      const sent = writes.map((w) => `${w.method} ${w.path}`)
      return JSON.stringify(sent) === JSON.stringify([`POST /transactions/${txn.id}/repeat`]) || `writes ${JSON.stringify(sent)}`
    })
    const body = writes[0]?.body ?? {}
    await h.check('c.no-budget-entry-id', 'B', async () => !('budget_entry_id' in (body.transaction ?? {})) || `transaction ${JSON.stringify(body.transaction)}`)
    await h.check('c.edits-sent', 'B', async () =>
      (body.transaction?.description === name && body.transaction?.amount === 1500) || `transaction ${JSON.stringify(body.transaction)}`)
    await h.check('c.repeat-body', 'B', async () => {
      const expected = { cadence: 'monthly', anchor_day: Number(day(0).slice(8)), day_rule: null, end_mode: 'indefinite', billing_kind: null, settlement: 'manual' }
      return JSON.stringify(body.repeat) === JSON.stringify(expected) || `repeat ${JSON.stringify(body.repeat)}`
    })
    await h.check('c.one-row', 'B', async () => {
      await rowFor(page, name).waitFor({ timeout: 10000 })
      return (await rowsFor(page, name).count()) === 1 || `rows ${await rowsFor(page, name).count()}`
    })
    const entries = await entriesNamed(user, name)
    const entry = entries[0]
    const stored = await client.get(user.token, `/transactions/${txn.id}`)
    await h.check('c.one-entry-next-after-row', 'B', async () =>
      (entries.length === 1 && entry.next_occurrence.slice(0, 10) > day(0)) || `entries ${JSON.stringify(entries.map((e) => e.next_occurrence))}`)
    await h.check('c.row-linked', 'B', async () =>
      (stored.budget_entry_id === entry?.id && stored.description === name && stored.amount === 1500) ||
      `row ${JSON.stringify({ budget_entry_id: stored.budget_entry_id, description: stored.description, amount: stored.amount })}`)

    // (d) The linked row.
    await h.check('d.row-reads-schedule', 'B', async () => {
      await rowFor(page, name).filter({ hasText: `${name} • Monthly` }).waitFor({ timeout: 10000 })
      return true
    })
    modal = await openEdit(page, name)
    await h.check('d.edit-no-toggle', 'B', async () => (await toggle(modal).count()) === 0 || 'toggle on the linked row')
    await h.check('d.edit-shows-entry', 'B', async () => {
      const value = await linkSelect(modal).inputValue()
      return value === String(entry?.id) || `link ${value}, entry ${entry?.id}`
    })
    await linkSelect(modal).selectOption('')
    await h.check('d.none-keeps-toggle-hidden', 'B', async () => (await toggle(modal).count()) === 0 || 'toggle after picking None')
    await cancel(page, modal)

    await page.goto(`${stack.webUrl}/transactions?view=scheduled`)
    await page.locator('[data-testid="scheduled-view"][aria-busy="false"]').waitFor({ timeout: 15000 })
    await h.check('d.scheduled-lists-next', 'B', async () => {
      const item = page.locator('[data-testid="scheduled-list"] > li').filter({ hasText: name }).first()
      await item.waitFor({ timeout: 10000 })
      const listed = await page.locator('[data-testid="scheduled-list"] > li').filter({ hasText: name }).evaluateAll((els) => els.map((e) => (e.dataset.day ?? '').slice(0, 10)))
      return JSON.stringify(listed.slice(0, 1)) === JSON.stringify([entry?.next_occurrence.slice(0, 10)]) && !listed.includes(day(0)) ||
        `listed ${JSON.stringify(listed)}, next ${entry?.next_occurrence}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

const failedToast = (page, description) =>
  page.locator('[data-testid="save-toast"][data-state="failed"]').filter({ hasText: description })
/**
 * STU-605: a refusal arrives after the dialog closed, as a failed toast; its Edit reopens
 * the form with the typed values and the refusal shown where the dialog used to show it.
 * Waits for the toast naming `description`, clicks Edit and waits for the Edit dialog.
 */
async function editRefused(page, modal, description) {
  const toast = failedToast(page, description).last()
  await toast.waitFor({ timeout: 10000 })
  await toast.locator('[data-testid="save-toast-edit"]').click()
  await modal.waitFor({ timeout: 5000 })
  await h.waitQuiet(page)
}

// (e) Refusals: nothing changes, and each reason shows where it belongs.
async function scenarioE(browser) {
  console.log('\n=== (e) a refused save changes nothing; reasons inline; an old API offers Retry')
  const user = await h.makeUser(stack, 'mre')
  const bank = await account(user, 'MRE Checking')
  const txn = await seed(user, bank, 'MRE Water', { is_posted: false, amount: 300, projected_amount: 300 })
  const before = await client.get(user.token, `/transactions/${txn.id}`)
  const { ctx, page, native, writes } = await openPage(browser, user)
  try {
    const modal = await openEdit(page, 'MRE Water')
    await control(modal, 'description').fill('MRE Water bill')
    await control(modal, 'transaction_date').fill(day(-40))
    await toggle(modal).check()
    await fields(modal).waitFor()
    await fields(modal).locator('[data-testid="repeat-settlement"]').selectOption('autopay')
    writes.length = 0
    const refused = await update(page, modal)
    await editRefused(page, modal, 'MRE Water')
    await h.check('e.refused-422', 'B', async () => refused.status() === 422 || `status ${refused.status()}`)
    await h.check('e.reason-on-form-line', 'B', async () => {
      const line = modal.locator('[data-testid="transaction-form-error"]')
      await line.waitFor({ timeout: 5000 })
      return (await line.innerText()).trim() === AUTOPAY_REASON || `error ${JSON.stringify(await line.innerText())}`
    })
    await h.check('e.form-kept', 'B', async () => {
      const kept = [
        await control(modal, 'description').inputValue(),
        await control(modal, 'transaction_date').inputValue(),
        await toggle(modal).isChecked(),
        await fields(modal).locator('[data-testid="repeat-settlement"]').inputValue(),
      ]
      return JSON.stringify(kept) === JSON.stringify(['MRE Water bill', day(-40), true, 'autopay']) || `kept ${JSON.stringify(kept)}`
    })
    await h.check('e.one-write-no-put', 'B', async () =>
      JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)) === JSON.stringify([`POST /transactions/${txn.id}/repeat`]) || `writes ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`)
    const after = await client.get(user.token, `/transactions/${txn.id}`)
    await h.check('e.row-unchanged', 'B', async () => {
      const pick = (t) => JSON.stringify([t.description, t.transaction_date, t.projected_amount, t.budget_entry_id ?? null, t.updated_at ?? null])
      return pick(after) === pick(before) || `before ${pick(before)}, after ${pick(after)}`
    })
    await h.check('e.no-entry', 'B', async () => {
      const n = (await entriesNamed(user, 'MRE Water bill')).length + (await entriesNamed(user, 'MRE Water')).length
      return n === 0 || `entries ${n}`
    })

    // Back to today, manual: the rest are answered without reaching the server.
    await control(modal, 'transaction_date').fill(day(0))
    await fields(modal).locator('[data-testid="repeat-settlement"]').selectOption('manual')
    await answerRepeat(page, 422, { detail: [{ loc: ['body', 'repeat', 'settlement'], msg: 'settlement refused', type: 'value_error' }] })
    await update(page, modal)
    await editRefused(page, modal, 'MRE Water')
    await h.check('e.settlement-error-on-control', 'B', async () => {
      const error = modal.locator('[data-testid="repeat-error-settlement"]')
      await error.waitFor({ timeout: 5000 })
      const text = (await error.innerText()).trim()
      const target = repeatControl(modal, 'settlement')
      const invalid = await target.getAttribute('aria-invalid')
      const describedBy = await target.getAttribute('aria-describedby')
      const focused = await target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement))
      return (text === 'settlement refused' && invalid === 'true' && describedBy === 'repeat-settlement-error' && focused) ||
        `text ${JSON.stringify(text)}, aria-invalid ${invalid}, describedby ${describedBy}, focused ${focused}`
    })
    await answerRepeat(page, 422, { detail: [{ loc: ['body', 'transaction', 'description'], msg: 'description refused', type: 'value_error' }] })
    await update(page, modal)
    await editRefused(page, modal, 'MRE Water')
    await h.check('e.description-error-on-field', 'B', async () => {
      const error = modal.locator('[data-testid="field-error-description"]')
      await error.waitFor({ timeout: 5000 })
      const invalid = await control(modal, 'description').getAttribute('aria-invalid')
      const focused = await control(modal, 'description').evaluate((el) => el === document.activeElement)
      return ((await error.innerText()).trim() === 'description refused' && invalid === 'true' && focused) ||
        `error ${JSON.stringify(await error.innerText())}, aria-invalid ${invalid}, focused ${focused}`
    })
    await answerRepeat(page, 404, { detail: 'Transaction not found' })
    await update(page, modal)
    await editRefused(page, modal, 'MRE Water')
    await h.check('e.404-reason-no-retry', 'B', async () => {
      const line = modal.locator('[data-testid="transaction-form-error"]')
      await line.filter({ hasText: 'Transaction not found' }).waitFor({ timeout: 5000 })
      const retry = await modal.locator('[data-testid="repeat-unavailable"]').count()
      return retry === 0 || 'Repeat shown as unavailable'
    })

    // An API from before the endpoint: a bare 404, then Retry once it answers.
    const old = await answerRepeat(page, 404, { detail: 'Not Found' })
    await update(page, modal)
    await editRefused(page, modal, 'MRE Water')
    await h.check('e.unavailable-edit-copy', 'B', async () => {
      const box = modal.locator('[data-testid="repeat-unavailable"]')
      await box.waitFor({ timeout: 5000 })
      return (await box.locator('p').innerText()).trim() === EDIT_UNAVAILABLE || `copy ${JSON.stringify(await box.locator('p').innerText())}`
    })
    writes.length = 0
    const [retried] = await Promise.all([
      page.waitForResponse(isRepeatPost),
      modal.locator('[data-testid="repeat-retry"]').click(),
    ])
    await modal.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    await h.check('e.retry-saves', 'B', async () =>
      (retried.status() === 201 && old.hits === 1) || `status ${retried.status()} ${await retried.text()}, stale hits ${old.hits}`)
    const linked = await client.get(user.token, `/transactions/${txn.id}`)
    const entries = await entriesNamed(user, 'MRE Water bill')
    await h.check('e.retry-linked-once', 'B', async () =>
      (entries.length === 1 && linked.budget_entry_id === entries[0].id && writes.filter((w) => w.method === 'PUT').length === 0) ||
      `entries ${entries.length}, link ${linked.budget_entry_id}, writes ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`)
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) A phone-width dialog.
async function scenarioF(browser) {
  console.log('\n=== (f) at 390px: no horizontal scroll, 44px targets')
  const user = await h.makeUser(stack, 'mrf')
  const bank = await account(user, 'MRF Checking')
  await seed(user, bank, 'MRF Phone')
  const { ctx, page, native } = await openPage(browser, user, { viewport: { width: 390, height: 844 } })
  try {
    const modal = await openEdit(page, 'MRF Phone')
    await toggle(modal).check()
    await fields(modal).getByRole('button', { name: 'On date', exact: true }).click()
    await fields(modal).getByRole('button', { name: 'After runs', exact: true }).click()
    await h.check('f.no-page-scroll', 'B', async () => {
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      return scroll <= width || `page ${scroll} > ${width}`
    })
    await h.check('f.no-fieldset-scroll', 'B', async () => {
      const [scroll, width] = await fields(modal).evaluate((el) => [el.scrollWidth, el.clientWidth])
      return scroll <= width || `fieldset ${scroll} > ${width}`
    })
    await h.check('f.targets-44px', 'B', async () => {
      const small = await modal.locator('[data-testid="repeat-section"]').evaluate((section) =>
        [...section.querySelectorAll('button, select, input:not([type="checkbox"]), label:has(input[type="checkbox"])')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => [el.tagName, el.textContent.trim().slice(0, 20), Math.round(el.getBoundingClientRect().height)])
          .filter(([, , height]) => height < 44))
      return small.length === 0 || `under 44px: ${JSON.stringify(small)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await ctx.close()
  }
}

const SCENARIOS = [['a', scenarioA], ['b', scenarioB], ['c', scenarioC], ['e', scenarioE], ['f', scenarioF]]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  for (const [name, run] of SCENARIOS) {
    if (only && only !== name) continue
    try {
      await run(browser)
    } catch (e) {
      await h.check(`${name}.completed`, 'B', async () => `scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
    }
  }
  await browser.close()
  stack.stop()
  process.exit(h.report())
})().catch((e) => { console.error(e); stack?.stop(); process.exit(2) })
