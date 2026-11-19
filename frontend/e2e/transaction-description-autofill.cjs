// Browser checks for STU-626: Add transaction fills itself from the latest transaction with
// the same description. While Description is typed, the descriptions used before are listed
// under it (most recent first); picking one, or leaving the field on an exact match (any
// case), fills type, account, category, tags and a transfer's from and to accounts from the
// latest such transaction, at once and with no prompt. Never the amount, never Description,
// never a field the user already changed in this form; Edit never autofills.
//
// Scenarios (the ticket's names):
//   desktop  saved_description_autofills_desktop, add_autofill, empty_amount_is_preserved,
//            unlisted_fields_are_preserved (a transfer too)
//   phone    saved_description_autofills_phone (iPhone-sized, touch), and the toast stack
//            does not cover the suggestion list
//   changes  autofill_preserves_user_changes, entered_amount_is_preserved
//   blur     case_insensitive_matching, exact_match_on_blur, nonmatch_on_blur
//   another  save_and_add_another_resets_tracking
//   repeat   repeat_autofill
//   edit     edit_does_not_autofill
//   failure  suggestion_failure_preserves_manual_entry
//   stale    stale_suggestion_response_is_ignored
//   source   autofill_preserves_user_changes: an account picked on an expense is the source of
//            a transfer autofilled after it (PR #172 audit)
//   sequence unavailable_references_are_skipped: a second autofill blanks the category, tags and
//            transfer accounts the first filled when it has none to give (PR #172 audit)
//   currency the recording currency follows an autofilled account, as a manual pick; a currency
//            the user chose in this form is kept (PR #172 audit)
//   type     STU-633: autofill that changes the type runs the type-button clean-up first.
//            type_change_clears_links, type_change_replaces_mismatched_category,
//            same_type_autofill_unchanged, type_change_save_desktop, type_change_save_phone
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/transaction-description-autofill.cjs [scenario]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { pick, chipOf } = require('./_picker.cjs')

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

// An iPhone 13/14-sized screen, touch, as the tester's phone.
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }

const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (day, n) => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
const wire = (day) => `${day}T09:00:00`

const formModal = (page, heading) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const createModal = (page) => formModal(page, 'Add transaction')
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const list = (modal) => modal.locator('[data-testid="description-suggestions"]')
const options = (modal) => modal.locator('[data-testid="description-suggestion"]')
const primaryOf = (modal) => modal.getByRole('button', { name: 'Add transaction', exact: true })
const anotherOf = (modal) => modal.locator('[data-testid="save-and-add-another"]')
const rowFor = (page, description) => page.locator('article[data-transaction-id]').filter({ hasText: description }).first()
const isSuggest = (r) => new URL(r.url()).pathname.endsWith('/transactions/description-suggestions')
const isCreate = (r) => r.method() === 'POST' && new URL(r.url()).pathname.replace(/\/$/, '').endsWith('/transactions')
const toastFor = (page, description) => page.locator('[data-testid="save-toast"]').filter({ hasText: description })
const waitToast = (page, description, state, ms = 10000) =>
  toastFor(page, description).and(page.locator(`[data-state="${state}"]`)).first().waitFor({ timeout: ms }).then(() => true, () => false)

async function until(read, ok, ms = 6000) {
  const stop = Date.now() + ms
  let last
  for (;;) {
    last = await read().catch(() => undefined)
    if (ok(last) || Date.now() > stop) return last
    await h.sleep(50)
  }
}

/** What the form shows in every field autofill may touch, and the ones it must not. */
async function formState(modal) {
  const line = async (key) => {
    const value = control(modal, key).locator('[data-picker-value]')
    return (await value.count()) === 1 ? ((await value.textContent()) || '').trim() : ''
  }
  const typeOf = async () => {
    for (const name of ['Income', 'Expense', 'Transfer']) {
      const button = modal.getByRole('button', { name, exact: true })
      if ((await button.count()) && ((await button.first().getAttribute('aria-pressed')) === 'true')) return name
    }
    return ''
  }
  const tags = await modal.locator('[data-testid="tag-picker"] button[aria-pressed="true"]').allTextContents()
  return {
    description: await control(modal, 'description').inputValue(),
    amount: (await control(modal, 'amount').count()) ? await control(modal, 'amount').inputValue() : null,
    date: await control(modal, 'transaction_date').inputValue(),
    type: await typeOf(),
    account: await line('account_id'),
    destination: (await control(modal, 'transfer_to_account_id').count()) ? await line('transfer_to_account_id') : null,
    category: await line('category_id'),
    tags: tags.map((t) => t.trim()).sort(),
  }
}
const starts = (got, name) => typeof got === 'string' && got.startsWith(name)
// A category picker with nothing chosen reads "Uncategorized" ("None" on a transfer).
const noCategory = (got) => got === '' || got === 'Uncategorized' || got === 'None'

/** A user with three accounts, two categories and two tags; `history` posts earlier rows. */
async function seedUser(tag) {
  const user = await h.makeUser(stack, tag)
  const post = (url, body) => client.post(user.token, url, body)
  const seed = { user }
  seed.bank = await post('/accounts/', { name: 'Auto Bank', account_type: 'checking', balance: 100000, currency: 'PHP' })
  seed.cash = await post('/accounts/', { name: 'Auto Cash', account_type: 'cash', balance: 5000, currency: 'PHP' })
  seed.savings = await post('/accounts/', { name: 'Auto Savings', account_type: 'savings', balance: 1000, currency: 'PHP' })
  seed.food = await post('/categories/', { name: 'Auto Food', color: '#16a34a', is_expense: true })
  seed.fun = await post('/categories/', { name: 'Auto Fun', color: '#2563eb', is_expense: true })
  seed.tagA = await post('/tags/', { name: 'Auto Tag A' })
  seed.tagB = await post('/tags/', { name: 'Auto Tag B' })
  return seed
}
/** Earlier rows: "Kopi Roti" twice (the latest on Auto Cash, Auto Food, Tag A) and a transfer. */
async function seedHistory(seed) {
  const post = (body) => client.post(seed.user.token, '/transactions/', { amount: 100, is_posted: true, ...body })
  await post({ account_id: seed.bank.id, transaction_type: 'debit', description: 'Kopi Roti',
    transaction_date: wire(addDays(today(), -9)), category_id: seed.fun.id, tag_ids: [seed.tagB.id] })
  await post({ account_id: seed.cash.id, transaction_type: 'debit', description: 'Kopi Roti',
    transaction_date: wire(addDays(today(), -2)), category_id: seed.food.id, tag_ids: [seed.tagA.id], amount: 777 })
  await post({ account_id: seed.bank.id, transaction_type: 'transfer', description: 'Move to savings',
    transaction_date: wire(addDays(today(), -3)), transfer_from_account_id: seed.bank.id,
    transfer_to_account_id: seed.savings.id })
}

async function openPage(browser, user, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila', ...contextOptions })
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const creates = []
  const suggests = []
  page.on('request', (r) => {
    if (isCreate(r)) { try { creates.push(JSON.parse(r.postData() || '{}')) } catch { creates.push(null) } }
    if (isSuggest(r)) suggests.push(new URL(r.url()).searchParams.get('q'))
  })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, creates, suggests }
}

async function openAdd(page) {
  await h.waitQuiet(page)
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const modal = createModal(page)
  await modal.waitFor()
  await h.waitQuiet(page)
  return modal
}

/** Types `text` into Description key by key (as a person does) and waits for the list. */
async function typeDescription(modal, text, { expectList = true } = {}) {
  const input = control(modal, 'description')
  await input.click()
  await input.fill('')
  await input.pressSequentially(text, { delay: 30 })
  if (expectList) await list(modal).waitFor({ timeout: 5000 }).catch(() => {})
}
async function choose(modal, description, { tap = false } = {}) {
  const option = options(modal).filter({ hasText: new RegExp(`^${description}$`) }).first()
  if (tap) await option.tap()
  else await option.click()
}
const listed = async (modal) => ((await list(modal).count()) ? (await options(modal).allTextContents()).map((t) => t.trim()) : [])

// ─── desktop ────────────────────────────────────────────────────────────────
async function desktopOrPhone(browser, phone) {
  const name = phone ? 'phone' : 'desktop'
  const id = phone ? 'saved_description_autofills_phone' : 'saved_description_autofills_desktop'
  console.log(`\n=== (${name}) a saved description fills the next Add form`)
  const seed = await seedUser(name)
  await seedHistory(seed)
  const { ctx, page, native, creates } = await openPage(browser, seed.user, phone ? PHONE : {})
  try {
    // Add a transaction with a description never used before, through the form.
    let modal = await openAdd(page)
    await control(modal, 'description').fill('Sari-sari Store')
    await pick(control(modal, 'account_id'), 'Auto Cash')
    await pick(control(modal, 'category_id'), 'Auto Fun')
    await modal.locator('[data-testid="tag-picker"]').getByRole('button', { name: /^Auto Tag B/ }).click()
    await control(modal, 'amount').fill('45')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await h.check(`${id}.first-save`, 'S', async () => (await waitToast(page, 'Sari-sari Store', 'saved')) || 'the save toast never read saved')

    modal = await openAdd(page)
    const dateBefore = await control(modal, 'transaction_date').inputValue()
    await typeDescription(modal, 'sari')
    await h.check(`${id}.suggested`, 'B', async () => {
      const got = await listed(modal)
      return (got.length === 1 && got[0] === 'Sari-sari Store') || `listed ${JSON.stringify(got)}`
    })
    if (phone) {
      // The save's toast is on screen; it must not cover the list (the toast stack sits at the bottom).
      await h.check('phone.toast-does-not-cover-suggestions', 'B', async () => {
        const toast = page.locator('[data-testid="toast-stack"]')
        if (!(await toast.count())) return 'no toast on screen to compare with'
        const [a, b] = [await list(modal).boundingBox(), await toast.boundingBox()]
        if (!a || !b) return `boxes ${JSON.stringify([a, b])}`
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        return !overlap || `list ${JSON.stringify(a)} under the toast stack ${JSON.stringify(b)}`
      })
      await h.check('phone.suggestion-target-44px', 'S', async () => {
        const box = await options(modal).first().boundingBox()
        return (box && box.height >= 44) || `option box ${JSON.stringify(box)}`
      })
      await h.check('phone.no-horizontal-scroll', 'S', async () => {
        const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
        return !wide || 'the page scrolls sideways'
      })
    }
    await choose(modal, 'Sari-sari Store', { tap: phone })
    await h.check(`${id}.fields-filled`, 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Cash'))
      const ok = got.description === 'Sari-sari Store' && got.type === 'Expense' && starts(got.account, 'Auto Cash') &&
        starts(got.category, 'Auto Fun') && JSON.stringify(got.tags) === JSON.stringify(['Auto Tag B'])
      return ok || `form ${JSON.stringify(got)}`
    })
    await h.check(`${phone ? 'phone' : 'desktop'}.empty_amount_is_preserved`, 'B', async () => {
      const got = await formState(modal)
      return got.amount === '' || `amount ${JSON.stringify(got.amount)}`
    })
    await h.check(`${phone ? 'phone' : 'desktop'}.no-confirmation`, 'B', async () => {
      const shown = await d.confirmDialog(page).dialog.count()
      return (shown === 0 && native.count === 0) || `confirm dialog ${shown}, native ${native.count}`
    })
    await h.check(`${phone ? 'phone' : 'desktop'}.unlisted_fields_are_preserved`, 'B', async () => {
      const got = await formState(modal)
      return got.date === dateBefore || `date ${got.date}, was ${dateBefore}`
    })
    // Saved with an amount typed after: the request carries every filled value.
    await control(modal, 'amount').fill('60')
    const before = creates.length
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n > before)
    await h.check(`${id}.saved-body`, 'B', async () => {
      const body = creates[creates.length - 1]
      const ok = body && body.description === 'Sari-sari Store' && body.account_id === seed.cash.id && body.category_id === seed.fun.id &&
        JSON.stringify(body.tag_ids) === JSON.stringify([seed.tagB.id]) && body.transaction_type === 'debit' && Number(body.amount) === 60
      return ok || `body ${JSON.stringify(body)}`
    })

    if (!phone) {
      // add_autofill on the seeded history: the latest "Kopi Roti" wins; and a transfer.
      modal = await openAdd(page)
      await typeDescription(modal, 'Kop')
      await choose(modal, 'Kopi Roti')
      await h.check('add_autofill.latest-row', 'B', async () => {
        const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Cash'))
        const ok = starts(got.account, 'Auto Cash') && starts(got.category, 'Auto Food') &&
          JSON.stringify(got.tags) === JSON.stringify(['Auto Tag A']) && got.amount === ''
        return ok || `form ${JSON.stringify(got)}`
      })
      await typeDescription(modal, 'move')
      await choose(modal, 'Move to savings')
      await h.check('add_autofill.transfer', 'B', async () => {
        const got = await until(() => formState(modal), (s) => s.type === 'Transfer' && starts(s.destination, 'Auto Savings'))
        const ok = got.type === 'Transfer' && starts(got.account, 'Auto Bank') && starts(got.destination, 'Auto Savings')
        return ok || `form ${JSON.stringify(got)}`
      })
      await h.check('desktop.unlisted_fields_are_preserved.transfer', 'B', async () => {
        const got = await formState(modal)
        // The category and tags filled from "Kopi Roti" were not the user's and the transfer has none: blank.
        const ok = got.description === 'Move to savings' && got.date === dateBefore && noCategory(got.category) && got.tags.length === 0
        return ok || `form ${JSON.stringify(got)}`
      })
      await control(modal, 'amount').fill('300')
      const n = creates.length
      await h.waitQuiet(page)
      await primaryOf(modal).click()
      await until(async () => creates.length, (c) => c > n)
      await h.check('add_autofill.transfer-body', 'B', async () => {
        const body = creates[creates.length - 1]
        const ok = body && body.transaction_type === 'transfer' && body.transfer_from_account_id === seed.bank.id &&
          body.transfer_to_account_id === seed.savings.id && body.account_id === seed.bank.id && Number(body.amount) === 300
        return ok || `body ${JSON.stringify(body)}`
      })
    }
  } finally {
    await d.checkNoNativeDialogs(h, name, native)
    await ctx.close()
  }
}

// ─── user changes survive ───────────────────────────────────────────────────
async function scenarioChanges(browser) {
  console.log('\n=== (changes) fields the user changed keep their values; a typed amount stays')
  const seed = await seedUser('changes')
  await seedHistory(seed)
  const { ctx, page, native } = await openPage(browser, seed.user)
  try {
    const modal = await openAdd(page)
    await pick(control(modal, 'account_id'), 'Auto Bank')
    await pick(control(modal, 'category_id'), 'Auto Fun')
    await control(modal, 'amount').fill('123.45')
    await typeDescription(modal, 'kopi')
    await choose(modal, 'Kopi Roti')
    await h.check('autofill_preserves_user_changes', 'B', async () => {
      const got = await until(() => formState(modal), (s) => s.tags.length > 0)
      const ok = starts(got.account, 'Auto Bank') && starts(got.category, 'Auto Fun') && got.type === 'Expense' &&
        JSON.stringify(got.tags) === JSON.stringify(['Auto Tag A'])
      return ok || `form ${JSON.stringify(got)}`
    })
    await h.check('entered_amount_is_preserved', 'B', async () => {
      const got = await formState(modal)
      return got.amount === '123.45' || `amount ${JSON.stringify(got.amount)}`
    })
    // A type the user chose is theirs too.
    await modal.getByRole('button', { name: 'Income', exact: true }).click()
    await typeDescription(modal, 'Move')
    await choose(modal, 'Move to savings')
    await h.check('autofill_preserves_user_changes.type', 'B', async () => {
      await h.sleep(300)
      const got = await formState(modal)
      return (got.type === 'Income' && starts(got.account, 'Auto Bank')) || `form ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'changes', native)
    await ctx.close()
  }
}

// ─── blur ───────────────────────────────────────────────────────────────────
async function scenarioBlur(browser) {
  console.log('\n=== (blur) case-insensitive matching; leaving on an exact match autofills, on anything else does nothing')
  const seed = await seedUser('blur')
  await seedHistory(seed)
  const { ctx, page, native } = await openPage(browser, seed.user)
  try {
    let modal = await openAdd(page)
    await typeDescription(modal, 'KOPI')
    await h.check('case_insensitive_matching', 'B', async () => {
      const got = await listed(modal)
      return JSON.stringify(got) === JSON.stringify(['Kopi Roti']) || `listed ${JSON.stringify(got)}`
    })
    // A prefix, not a description: leaving does nothing.
    await control(modal, 'description').press('Tab')
    await h.sleep(600)
    await h.check('nonmatch_on_blur', 'B', async () => {
      const got = await formState(modal)
      return (got.account === '' && noCategory(got.category) && got.tags.length === 0 && got.description === 'KOPI') || `form ${JSON.stringify(got)}`
    })
    // The whole description in another case, typed fast and left at once (before any list).
    await control(modal, 'description').fill('kopi ROTI')
    await control(modal, 'description').press('Tab')
    await h.check('exact_match_on_blur', 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Cash') && s.tags.length > 0)
      const ok = starts(got.account, 'Auto Cash') && starts(got.category, 'Auto Food') &&
        JSON.stringify(got.tags) === JSON.stringify(['Auto Tag A'])
      return ok || `form ${JSON.stringify(got)}`
    })
    await h.check('exact_match_on_blur.description-untouched', 'B', async () => {
      const got = await formState(modal)
      return (got.description === 'kopi ROTI' && got.amount === '') || `form ${JSON.stringify(got)}`
    })
    await modal.getByRole('button', { name: 'Close transaction modal' }).click()
    modal = await openAdd(page)
    await typeDescription(modal, 'Kopi Rotis', { expectList: false })
    await control(modal, 'description').press('Tab')
    await h.sleep(600)
    await h.check('nonmatch_on_blur.longer', 'B', async () => {
      const got = await formState(modal)
      return (got.account === '' && noCategory(got.category)) || `form ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'blur', native)
    await ctx.close()
  }
}

// ─── save and add another ───────────────────────────────────────────────────
async function scenarioAnother(browser) {
  console.log('\n=== (another) "Save and add another" forgets what the previous entry changed')
  const seed = await seedUser('another')
  await seedHistory(seed)
  const { ctx, page, native, creates } = await openPage(browser, seed.user)
  try {
    const modal = await openAdd(page)
    await pick(control(modal, 'account_id'), 'Auto Bank')
    await control(modal, 'description').fill('Lunch out')
    await control(modal, 'amount').fill('250')
    await h.waitQuiet(page)
    await anotherOf(modal).click()
    await until(async () => creates.length, (n) => n >= 1)
    await h.check('save_and_add_another_resets_tracking.kept-account', 'S', async () => {
      const got = await until(() => formState(modal), (s) => s.description === '')
      return starts(got.account, 'Auto Bank') || `form ${JSON.stringify(got)}`
    })
    await typeDescription(modal, 'Kopi')
    await choose(modal, 'Kopi Roti')
    await h.check('save_and_add_another_resets_tracking', 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Cash'))
      return (starts(got.account, 'Auto Cash') && starts(got.category, 'Auto Food')) || `form ${JSON.stringify(got)}`
    })
    // Changes in the new entry are tracked again.
    await pick(control(modal, 'account_id'), 'Auto Savings')
    await typeDescription(modal, 'Kopi')
    await choose(modal, 'Kopi Roti')
    await h.check('save_and_add_another_resets_tracking.new-changes-kept', 'B', async () => {
      await h.sleep(300)
      const got = await formState(modal)
      return starts(got.account, 'Auto Savings') || `form ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'another', native)
    await ctx.close()
  }
}

// ─── repeat ─────────────────────────────────────────────────────────────────
async function scenarioRepeat(browser) {
  console.log('\n=== (repeat) autofill with Repeat on')
  const seed = await seedUser('repeat')
  await seedHistory(seed)
  const { ctx, page, native, creates } = await openPage(browser, seed.user)
  try {
    const modal = await openAdd(page)
    await modal.locator('[data-testid="repeat-toggle"]').check()
    await typeDescription(modal, 'kopi')
    await choose(modal, 'Kopi Roti')
    await h.check('repeat_autofill', 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Cash'))
      const on = await modal.locator('[data-testid="repeat-toggle"]').isChecked()
      return (on && starts(got.account, 'Auto Cash') && starts(got.category, 'Auto Food')) || `repeat ${on}, form ${JSON.stringify(got)}`
    })
    await control(modal, 'amount').fill('99')
    const posts = []
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/transactions/repeating')) posts.push(r.postDataJSON()) })
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => posts.length, (n) => n >= 1)
    await h.check('repeat_autofill.saved-body', 'B', async () => {
      const t = posts[0] && posts[0].transaction
      return (t && t.account_id === seed.cash.id && t.category_id === seed.food.id && Number(t.amount) === 99) || `posts ${JSON.stringify(posts)}`
    })
    void creates
  } finally {
    await d.checkNoNativeDialogs(h, 'repeat', native)
    await ctx.close()
  }
}

// ─── edit ───────────────────────────────────────────────────────────────────
async function scenarioEdit(browser) {
  console.log('\n=== (edit) Edit transaction never suggests or autofills')
  const seed = await seedUser('edit')
  await seedHistory(seed)
  await client.post(seed.user.token, '/transactions/', { amount: 50, is_posted: true, account_id: seed.bank.id,
    transaction_type: 'debit', description: 'Edit me', transaction_date: wire(addDays(today(), -1)) })
  const { ctx, page, native, suggests } = await openPage(browser, seed.user)
  try {
    await page.reload()
    await h.waitQuiet(page)
    const row = rowFor(page, 'Edit me')
    await row.waitFor()
    await row.click()
    const actions = formModal(page, 'Transaction actions')
    await actions.waitFor()
    await h.waitQuiet(page)
    await actions.getByRole('button', { name: 'Edit transaction', exact: true }).click()
    const modal = formModal(page, 'Edit transaction')
    await modal.waitFor()
    await h.waitQuiet(page)
    const before = await formState(modal)
    const asked = suggests.length
    await control(modal, 'description').click()
    await control(modal, 'description').fill('')
    await control(modal, 'description').pressSequentially('Kopi Roti', { delay: 30 })
    await h.sleep(400)
    await h.check('edit_does_not_autofill.no-list', 'B', async () =>
      ((await list(modal).count()) === 0 && suggests.length === asked) || `${suggests.length - asked} request(s), list ${await list(modal).count()}`)
    await control(modal, 'description').press('Tab')
    await h.sleep(600)
    await h.check('edit_does_not_autofill', 'B', async () => {
      const got = await formState(modal)
      const ok = got.account === before.account && got.category === before.category && got.type === before.type &&
        JSON.stringify(got.tags) === JSON.stringify(before.tags) && suggests.length === asked
      return ok || `before ${JSON.stringify(before)}, after ${JSON.stringify(got)}, requests ${suggests.length - asked}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'edit', native)
    await ctx.close()
  }
}

// ─── failure ────────────────────────────────────────────────────────────────
async function scenarioFailure(browser) {
  console.log('\n=== (failure) a failed suggestions request leaves the form usable')
  const seed = await seedUser('failure')
  await seedHistory(seed)
  const { ctx, page, native, creates, suggests } = await openPage(browser, seed.user)
  try {
    await page.route('**/transactions/description-suggestions*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }))
    const modal = await openAdd(page)
    await pick(control(modal, 'account_id'), 'Auto Bank')
    await control(modal, 'amount').fill('70')
    await typeDescription(modal, 'Kopi Roti', { expectList: false })
    await control(modal, 'description').press('Tab')
    await until(async () => suggests.length, (n) => n >= 1)
    await h.sleep(400)
    await h.check('suggestion_failure_preserves_manual_entry.values-kept', 'B', async () => {
      const got = await formState(modal)
      return (got.description === 'Kopi Roti' && got.amount === '70' && starts(got.account, 'Auto Bank') && suggests.length >= 1) ||
        `form ${JSON.stringify(got)}, ${suggests.length} request(s)`
    })
    await h.check('suggestion_failure_preserves_manual_entry.no-list', 'B', async () => (await list(modal).count()) === 0 || 'a list showed')
    await pick(control(modal, 'category_id'), 'Auto Fun')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n >= 1)
    await h.check('suggestion_failure_preserves_manual_entry', 'B', async () => {
      const body = creates[0]
      const saved = await waitToast(page, 'Kopi Roti', 'saved')
      const ok = saved && body && body.description === 'Kopi Roti' && body.account_id === seed.bank.id &&
        body.category_id === seed.fun.id && Number(body.amount) === 70
      return ok || `saved ${saved}, body ${JSON.stringify(body)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'failure', native)
    await ctx.close()
  }
}

// ─── stale ──────────────────────────────────────────────────────────────────
async function scenarioStale(browser) {
  console.log('\n=== (stale) a late answer for an earlier value never replaces the list or fills the form')
  const seed = await seedUser('stale')
  await seedHistory(seed)
  const { ctx, page, native } = await openPage(browser, seed.user)
  try {
    const held = {}
    const holdFor = new Set(['Ko', 'Kopi Roti'])
    await page.route('**/transactions/description-suggestions*', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q')
      if (holdFor.has(q) && !held[q]) { held[q] = route; return }
      return route.continue()
    })
    const fake = (description) => JSON.stringify({ items: [{ description, transaction_type: 'transfer',
      account_id: seed.savings.id, category_id: null, tag_ids: [seed.tagB.id],
      transfer_from_account_id: seed.savings.id, transfer_to_account_id: seed.bank.id }] })
    const modal = await openAdd(page)
    const input = control(modal, 'description')
    await input.click()
    await input.pressSequentially('Ko', { delay: 30 })
    await until(async () => Boolean(held.Ko), (v) => v === true, 3000)
    await input.pressSequentially('p', { delay: 30 })
    await list(modal).waitFor({ timeout: 5000 }).catch(() => {})
    await held.Ko?.fulfill({ status: 200, contentType: 'application/json', body: fake('Kopi Stale') })
    await h.sleep(500)
    await h.check('stale_suggestion_response_is_ignored.list', 'B', async () => {
      const got = await listed(modal)
      return JSON.stringify(got) === JSON.stringify(['Kopi Roti']) || `listed ${JSON.stringify(got)}`
    })
    // Left on an exact match whose answer is held; the Description then moves on before it lands.
    await input.fill('Kopi Roti')
    await input.press('Tab')
    await until(async () => Boolean(held['Kopi Roti']), (v) => v === true, 3000)
    await input.click()
    await input.press('End')
    await input.pressSequentially('s', { delay: 30 })
    await held['Kopi Roti']?.fulfill({ status: 200, contentType: 'application/json', body: fake('Kopi Roti') })
    await h.sleep(600)
    await h.check('stale_suggestion_response_is_ignored', 'B', async () => {
      const got = await formState(modal)
      const ok = Boolean(held.Ko && held['Kopi Roti']) && got.account === '' && got.type === 'Expense' && got.tags.length === 0 &&
        got.description === 'Kopi Rotis'
      return ok || `held ${Object.keys(held)}, form ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'stale', native)
    await ctx.close()
  }
}

// ─── source ─────────────────────────────────────────────────────────────────
async function scenarioSource(browser) {
  console.log('\n=== (source) an account picked on an expense is the source of a transfer autofilled after it')
  const seed = await seedUser('source')
  await seedHistory(seed)
  const { ctx, page, native, creates } = await openPage(browser, seed.user)
  try {
    const modal = await openAdd(page)
    await pick(control(modal, 'account_id'), 'Auto Cash')
    await typeDescription(modal, 'move')
    await choose(modal, 'Move to savings')
    await h.check('source.form', 'B', async () => {
      const got = await until(() => formState(modal), (s) => s.type === 'Transfer' && starts(s.destination, 'Auto Savings'))
      return (got.type === 'Transfer' && starts(got.account, 'Auto Cash') && starts(got.destination, 'Auto Savings')) ||
        `form ${JSON.stringify(got)}`
    })
    await control(modal, 'amount').fill('40')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n >= 1)
    await h.check('autofill_preserves_user_changes.transfer-source', 'B', async () => {
      const body = creates[0]
      const ok = body && body.transaction_type === 'transfer' && body.account_id === seed.cash.id &&
        body.transfer_from_account_id === seed.cash.id && body.transfer_to_account_id === seed.savings.id
      return ok || `body ${JSON.stringify(body)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'source', native)
    await ctx.close()
  }
}

// ─── sequence ───────────────────────────────────────────────────────────────
async function scenarioSequence(browser) {
  console.log('\n=== (sequence) a second autofill leaves nothing of the first it cannot fill itself')
  const seed = await seedUser('sequence')
  await seedHistory(seed)
  await client.post(seed.user.token, '/transactions/', { amount: 30, is_posted: true, account_id: seed.bank.id,
    transaction_type: 'debit', description: 'Plain Bill', transaction_date: wire(addDays(today(), -1)) })
  const { ctx, page, native, creates } = await openPage(browser, seed.user)
  try {
    const modal = await openAdd(page)
    await typeDescription(modal, 'move')
    await choose(modal, 'Move to savings')
    await until(() => formState(modal), (s) => starts(s.destination, 'Auto Savings'))
    await typeDescription(modal, 'kopi')
    await choose(modal, 'Kopi Roti')
    await h.check('sequence.first', 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.category, 'Auto Food') && s.tags.length > 0)
      return (got.type === 'Expense' && starts(got.category, 'Auto Food') && JSON.stringify(got.tags) === '["Auto Tag A"]') ||
        `form ${JSON.stringify(got)}`
    })
    await typeDescription(modal, 'plain')
    await choose(modal, 'Plain Bill')
    await h.check('unavailable_references_are_skipped.sequence', 'B', async () => {
      const got = await until(() => formState(modal), (s) => starts(s.account, 'Auto Bank') && s.tags.length === 0)
      return (starts(got.account, 'Auto Bank') && noCategory(got.category) && got.tags.length === 0) || `form ${JSON.stringify(got)}`
    })
    await control(modal, 'amount').fill('30')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n >= 1)
    await h.check('unavailable_references_are_skipped.sequence-body', 'B', async () => {
      const body = creates[0]
      const ok = body && body.account_id === seed.bank.id && body.category_id == null &&
        (body.tag_ids === undefined || (Array.isArray(body.tag_ids) && body.tag_ids.length === 0)) &&
        body.transfer_from_account_id == null && body.transfer_to_account_id == null
      return ok || `body ${JSON.stringify(body)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'sequence', native)
    await ctx.close()
  }
}

// ─── currency ───────────────────────────────────────────────────────────────
async function scenarioCurrency(browser) {
  console.log('\n=== (currency) the recording currency follows an autofilled account; a currency the user chose is kept')
  const seed = await seedUser('currency')
  const dollars = await client.post(seed.user.token, '/accounts/', { name: 'Auto Dollars', account_type: 'checking', balance: 500, currency: 'USD' })
  await client.post(seed.user.token, '/transactions/', { amount: 12, is_posted: true, account_id: dollars.id, currency: 'USD',
    transaction_type: 'debit', description: 'Dollar Lunch', transaction_date: wire(addDays(today(), -1)) })
  const { ctx, page, native, creates } = await openPage(browser, seed.user)
  const recording = (modal) => modal.getByText(/^Recording in [A-Z]{3}/).first().textContent().then((t) => (t || '').trim(), () => '')
  const currencySelect = (modal) => modal.locator('select').filter({ has: page.locator('option[value="EUR"]') }).first()
  try {
    // (a) The user never touched a currency: the form records in the autofilled account's.
    let modal = await openAdd(page)
    await typeDescription(modal, 'dollar')
    await choose(modal, 'Dollar Lunch')
    await h.check('currency.follows-autofilled-account', 'B', async () => {
      const text = await until(() => recording(modal), (t) => t.startsWith('Recording in USD'))
      return text.startsWith('Recording in USD') || `reads ${JSON.stringify(text)}`
    })
    await control(modal, 'amount').fill('10')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n >= 1)
    await h.check('currency.follows-autofilled-account.body', 'B', async () => {
      const body = creates[0]
      return (body && body.account_id === dollars.id && body.currency === 'USD' && body.projected_currency === 'USD') ||
        `body ${JSON.stringify(body)}`
    })

    // (b) The user chose EUR for a pending entry, then autofilled: EUR stays.
    modal = await openAdd(page)
    await modal.getByRole('checkbox', { name: 'Mark as posted' }).uncheck()
    await currencySelect(modal).selectOption('EUR')
    await typeDescription(modal, 'dollar')
    await choose(modal, 'Dollar Lunch')
    await until(() => formState(modal), (s) => starts(s.account, 'Auto Dollars'))
    await h.sleep(300)
    await h.check('currency.user-choice-kept', 'B', async () => {
      const value = await currencySelect(modal).inputValue()
      return value === 'EUR' || `currency select reads ${value}`
    })
    await control(modal, 'projected_amount').fill('10')
    await h.waitQuiet(page)
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n >= 2)
    await h.check('currency.user-choice-kept.body', 'B', async () => {
      const body = creates[1]
      return (body && body.account_id === dollars.id && body.projected_currency === 'EUR' && body.currency === 'USD') ||
        `body ${JSON.stringify(body)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'currency', native)
    await ctx.close()
  }
}

// ─── type change (STU-633) ──────────────────────────────────────────────────
/** Seed for STU-633: an expense recurring entry on an allocation, an income category, and history. */
async function seedTypeChange(tag) {
  const seed = await seedUser(tag)
  const post = (url, body) => client.post(seed.user.token, url, body)
  seed.salary = await post('/categories/', { name: 'Auto Salary', color: '#0891b2', is_expense: false })
  seed.allocation = await post('/allocations/', {
    account_id: seed.bank.id, name: 'Auto Envelope', allocation_type: 'budget', target_amount: 1000,
    period_frequency: 'monthly', period_start: wire(`${today().slice(0, 8)}01`),
    configuration: { category_ids: [seed.fun.id] },
  })
  seed.entry = await post('/budget-entries/', {
    entry_type: 'expense', currency: 'PHP', cadence: 'monthly', name: 'Auto Rent', amount: 500,
    account_id: seed.bank.id, category_id: seed.fun.id, allocation_id: seed.allocation.id,
    next_occurrence: wire(addDays(today(), 10)),
  })
  const hist = (body) => post('/transactions/', { amount: 100, is_posted: true, ...body })
  await hist({ account_id: seed.cash.id, transaction_type: 'credit', description: 'Pay Day',
    transaction_date: wire(addDays(today(), -4)), category_id: seed.salary.id })
  await hist({ account_id: seed.cash.id, transaction_type: 'debit', description: 'Kopi Roti',
    transaction_date: wire(addDays(today(), -2)), category_id: seed.food.id })
  await hist({ account_id: seed.bank.id, transaction_type: 'transfer', description: 'Move to savings',
    transaction_date: wire(addDays(today(), -3)), transfer_from_account_id: seed.bank.id, transfer_to_account_id: seed.savings.id })
  return seed
}
const linkSelect = (modal) => modal.locator('select').filter({ has: modal.page().locator('option', { hasText: 'Auto Rent' }) }).first()
const noEntries = (modal) => modal.getByText('No recurring entries of this type yet.')
/** Link the expense entry (it also sets the allocation and its category), as a person does. */
async function linkEntry(modal, seed) {
  await linkSelect(modal).selectOption(String(seed.entry.id))
  await h.sleep(200)
}

async function scenarioTypeChange(browser, phone) {
  const name = phone ? 'phone' : 'desktop'
  console.log(`\n=== (type_change ${name}) autofill that changes the type cleans up the old type's fields`)
  const seed = await seedTypeChange(`tc-${name}`)
  const { ctx, page, native, creates } = await openPage(browser, seed.user, phone ? PHONE : {})
  try {
    if (!phone) {
      // type_change_clears_links: Expense to Transfer, then Expense to Income.
      let modal = await openAdd(page)
      await linkEntry(modal, seed)
      await h.check('type_change_clears_links.linked', 'S', async () =>
        (await linkSelect(modal).inputValue()) === String(seed.entry.id) || 'the entry did not link')
      await typeDescription(modal, 'Move')
      await choose(modal, 'Move to savings')
      await h.check('type_change_clears_links.transfer', 'B', async () => {
        const got = await until(() => formState(modal), (s) => s.type === 'Transfer')
        return (got.type === 'Transfer' && (await linkSelect(modal).count()) === 0) || `form ${JSON.stringify(got)}`
      })
      // Back to Expense by hand: the entry and its envelope are gone, the form is not still linked.
      await modal.getByRole('button', { name: 'Expense', exact: true }).click()
      await h.check('type_change_clears_links', 'B', async () =>
        (await linkSelect(modal).inputValue()) === '' || 'the entry link came back')
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click()

      modal = await openAdd(page)
      await linkEntry(modal, seed)
      await typeDescription(modal, 'Pay')
      await choose(modal, 'Pay Day')
      let auto
      await h.check('type_change_clears_links', 'B', async () => {
        const got = await until(() => formState(modal), (s) => s.type === 'Income')
        auto = got
        if (got.type !== 'Income' || (await noEntries(modal).count()) !== 1) return `form ${JSON.stringify(got)}`
        // The link is not just hidden: back on Expense by hand, no entry is selected.
        await modal.getByRole('button', { name: 'Expense', exact: true }).click()
        return (await linkSelect(modal).inputValue()) === '' || 'the entry link came back on Expense'
      })
      // Same as a click: the type button on a linked expense, in a fresh form.
      await h.check('type_change_clears_links.same-as-click', 'B', async () => {
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
        modal = await openAdd(page)
        await linkEntry(modal, seed)
        await modal.getByRole('button', { name: 'Income', exact: true }).click()
        const click = await formState(modal)
        const sameLinks = (await noEntries(modal).count()) === 1
        return (sameLinks && starts(auto.category, 'Auto Salary') && noCategory(click.category)) || `auto ${JSON.stringify(auto)} click ${JSON.stringify(click)}`
      })
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click()

      // type_change_replaces_mismatched_category: an expense category the user picked.
      modal = await openAdd(page)
      await pick(control(modal, 'category_id'), 'Auto Food')
      await typeDescription(modal, 'Pay')
      await choose(modal, 'Pay Day')
      await h.check('type_change_replaces_mismatched_category', 'B', async () => {
        const got = await until(() => formState(modal), (s) => s.type === 'Income' && starts(s.category, 'Auto Salary'))
        return (got.type === 'Income' && starts(got.category, 'Auto Salary')) || `form ${JSON.stringify(got)}`
      })
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click()

      // same_type_autofill_unchanged: the type stays, so the link stays and the category is STU-626's.
      modal = await openAdd(page)
      await linkEntry(modal, seed)
      await typeDescription(modal, 'Kopi')
      await choose(modal, 'Kopi Roti')
      await h.check('same_type_autofill_unchanged', 'B', async () => {
        const got = await until(() => formState(modal), (s) => starts(s.category, 'Auto Food'))
        const linked = (await linkSelect(modal).count()) === 1 && (await linkSelect(modal).inputValue()) === String(seed.entry.id)
        return (got.type === 'Expense' && starts(got.category, 'Auto Food') && linked) || `form ${JSON.stringify(got)} linked ${linked}`
      })
      await control(modal, 'amount').fill('30')
      const before = creates.length
      await primaryOf(modal).click()
      await until(async () => creates.length, (n) => n > before)
      await h.check('same_type_autofill_unchanged.saved-body', 'B', async () => {
        const body = creates[creates.length - 1]
        const ok = body && body.budget_entry_id === seed.entry.id && body.allocation_id === seed.allocation.id && body.category_id === seed.food.id
        return ok || `body ${JSON.stringify(body)}`
      })
    }

    // type_change_save_desktop / type_change_save_phone: save a transfer autofilled over a linked
    // expense with an expense category the user picked. (A manual click to Income keeps an
    // allocation link, so the whole-record check uses the Transfer a click clears fully.)
    const modal = await openAdd(page)
    await linkEntry(modal, seed)
    await pick(control(modal, 'category_id'), 'Auto Food')
    await typeDescription(modal, 'Move')
    await choose(modal, 'Move to savings', { tap: phone })
    await h.check(`type_change_save_${name}.form`, 'B', async () => {
      const got = await until(() => formState(modal), (s) => s.type === 'Transfer')
      return (got.type === 'Transfer' && starts(got.destination, 'Auto Savings') && noCategory(got.category)) || `form ${JSON.stringify(got)}`
    })
    await control(modal, 'amount').fill('2500')
    await h.waitQuiet(page)
    const before = creates.length
    await primaryOf(modal).click()
    await until(async () => creates.length, (n) => n > before)
    await h.check(`type_change_save_${name}`, 'B', async () => {
      const body = creates[creates.length - 1]
      const ok = body && body.transaction_type === 'transfer' && body.description === 'Move to savings' && Number(body.amount) === 2500 &&
        !body.category_id && !body.budget_entry_id && !body.allocation_id &&
        body.account_id === seed.bank.id && body.transfer_to_account_id === seed.savings.id
      return ok || `body ${JSON.stringify(body)}`
    })
    await h.check(`type_change_save_${name}.saved`, 'S', async () => (await waitToast(page, 'Move to savings', 'saved')) || 'the save toast never read saved')
    await h.check(`type_change_save_${name}.stored`, 'B', async () => {
      const rows = await client.get(seed.user.token, '/transactions/?limit=50')
      const row = (rows.items || rows).find((t) => t.description === 'Move to savings' && Number(t.amount) === 2500)
      const ok = row && row.transaction_type === 'transfer' && !row.budget_entry_id && !row.allocation_id && !row.category_id
      return ok || `row ${JSON.stringify(row)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, `type_change ${name}`, native)
    await ctx.close()
  }
}

// ─── tags_slow ──────────────────────────────────────────────────────────────
// STU-636: the page reads /tags only once the form is open, so a suggestion can be picked before
// they arrive. Its tags must still be applied (PR #184 audit).
async function scenarioTagsSlow(browser) {
  console.log('\n=== (tags_slow) a suggestion picked before the tags load keeps its valid tags')
  const seed = await seedUser('tagsslow')
  await seedHistory(seed)
  const { ctx, page, native } = await openPage(browser, seed.user)
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let held = 0
    await page.route(/\/api\/v1\/tags\/?(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      held += 1
      await gate
      return route.continue()
    })
    await page.getByRole('button', { name: 'Add transaction' }).first().click()
    const modal = createModal(page)
    await modal.waitFor()
    await until(async () => held, (n) => n >= 1)
    await typeDescription(modal, 'kopi')
    await choose(modal, 'Kopi Roti')
    await h.sleep(400)
    await h.check('tags_slow.picked-while-tags-held', 'S', async () => held >= 1 || 'the /tags read was not held')
    release()
    await h.check('tags_slow.valid-tags-applied', 'B', async () => {
      const got = await until(() => formState(modal), (s) => s.tags.length > 0 && starts(s.category, 'Auto Food'))
      return (JSON.stringify(got.tags) === '["Auto Tag A"]' && starts(got.category, 'Auto Food') && got.description === 'Kopi Roti') ||
        `form ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'tags_slow', native)
    await ctx.close()
  }
}

const SCENARIOS = [
  ['desktop', (b) => desktopOrPhone(b, false)],
  ['phone', (b) => desktopOrPhone(b, true)],
  ['changes', scenarioChanges],
  ['blur', scenarioBlur],
  ['another', scenarioAnother],
  ['repeat', scenarioRepeat],
  ['edit', scenarioEdit],
  ['failure', scenarioFailure],
  ['stale', scenarioStale],
  ['source', scenarioSource],
  ['sequence', scenarioSequence],
  ['currency', scenarioCurrency],
  ['tags_slow', scenarioTagsSlow],
  ['type_change_desktop', (b) => scenarioTypeChange(b, false)],
  ['type_change_phone', (b) => scenarioTypeChange(b, true)],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  if (only && !SCENARIOS.some(([name]) => name === only)) {
    console.error(`Unknown scenario "${only}". Scenarios: ${SCENARIOS.map(([name]) => name).join(', ')}`)
    process.exit(2)
  }
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

void chipOf
