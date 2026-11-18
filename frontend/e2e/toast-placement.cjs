// Browser checks for STU-629: the stacked save toasts (STU-605) never cover a dialog's action
// buttons or the list rows' actions, at a phone width or on desktop.
//   (a) phone_dialog_button_clear: 390x844, 3 saves pending, the Add transaction dialog open:
//       its Create button is not covered by a toast (elementFromPoint) and takes a click.
//   (b) phone_last_row_clear: 390x844, 3 pending, dialog closed: the last list row scrolls into
//       view and can be clicked (its actions modal opens).
//   (c) desktop_last_row_clear: 1280x800, 3 pending: the bottom-right row's right-hand side
//       (where the toast stack sits) is uncovered and takes a click.
//   (d) toasts_still_usable: at both sizes the toasts stay on screen, readable and hit-testable;
//       Dismiss, Undo and Retry still work.
//   (e) responsive_dialog_actions_clear: with 2 and with 3 pending, at 390, 1280 and at widths
//       just below, at and just above each breakpoint the layout uses (sm 640, md 768, lg 1024),
//       every dialog action button is uncovered and can be clicked (trial click).
//   (f) responsive_form_primary_clear: the same widths and counts, a filled form's primary button
//       (all five sample points) is uncovered and can be clicked.
//   (g) responsive_visible_row_actions_clear: the same widths and counts, dialog closed: the
//       lowest fully visible row (inside the viewport, clear of the fixed bars and of the stack)
//       partway down the list and the last row at its end are uncovered and can be clicked. At the
//       end of the list the last row must be wholly clear of the stack.
// "Pending" saves are made by holding the create POST (route interception): the first request is
// held, the rest queue behind it in the save outbox, one pending toast each.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI. Run steps: ./README.md. Condition waits only.
//
// Usage: node frontend/e2e/toast-placement.cjs [scenario]   (a..g)
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

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
// The layout's breakpoints (Tailwind sm, md, lg), each probed just below, at and just above.
const BREAKPOINTS = [640, 768, 1024]
const WIDTHS = [PHONE.width, ...BREAKPOINTS.flatMap((w) => [w - 1, w, w + 1]), DESKTOP.width]
const sizeOf = (width) => (width === DESKTOP.width ? DESKTOP : { width, height: width < 768 ? 844 : 800 })

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

const toasts = (page) => page.locator(tid('save-toast'))
const toastFor = (page, description) => toasts(page).filter({ hasText: description })
const rows = (page) => page.locator('article[data-transaction-id]')
const formOf = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: /^(Create|Update) Transaction$/ }) })

async function shot(page, name) {
  if (!SHOTS) return
  await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {})
}

/** A user with one account and enough rows that the list scrolls. */
async function seedUser(tag) {
  const user = await h.makeUser(stack, tag)
  const checking = await client.post(user.token, '/accounts/', { name: `${tag} Checking`, account_type: 'checking', balance: 500000, currency: 'PHP' })
  const today = manilaToday()
  for (let i = 0; i < 28; i++) {
    await client.post(user.token, '/transactions/', {
      account_id: checking.id, transaction_type: 'debit', amount: 100 + i, description: `TP Seed ${String(i).padStart(2, '0')}`,
      transaction_date: wire(addDays(today, -(i % 20) - 1)),
    })
  }
  return { user, checking }
}

/** A fresh signed-in page on Transactions at `size`, with creates held at the network. */
async function openPage(browser, user, size = DESKTOP) {
  const { ctx, page } = await h.newPage(browser, { timezoneId: 'Asia/Manila', viewport: size })
  page.setDefaultTimeout(10000)
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add transaction' }).first().waitFor()
  await rows(page).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page }
}

async function fillCreate(page, { accountName, amount, description }) {
  await page.getByRole('button', { name: 'Add transaction' }).first().click()
  const form = formOf(page)
  await form.waitFor()
  await form.locator('input[placeholder="Add notes about this transaction"]').fill(description)
  await pick(form.locator('[data-field="account_id"]'), accountName)
  await form.getByRole('button', { name: 'Expense', exact: true }).click()
  await form.locator('input[type="number"][placeholder="0.00"]').first().fill(String(amount))
  return form
}

/**
 * Fills and submits the Create dialog. Submits with Enter, not a click on Create, so that making
 * the pending saves never depends on the button the placement checks are about.
 */
async function createUI(page, opts) {
  const form = await fillCreate(page, opts)
  await form.locator('input[placeholder="Add notes about this transaction"]').press('Enter')
  await form.waitFor({ state: 'hidden' })
}

/** Makes saves until `n` toasts are pending; the first POST is held. Returns the gate. */
async function makePending(page, checking, held, from, to, tag) {
  for (let i = from; i < to; i++) await createUI(page, { accountName: checking.name, amount: 200 + i, description: `${tag} Pending ${i + 1}` })
  await page.locator(`${tid('save-toast')}[data-state="pending"]`).nth(to - 1).waitFor()
  if (!(await held.waitHits(1))) throw new Error('no POST reached the hold')
}

/** Two frames, so a resize and the toast room it causes have been laid out. */
// (The page scrolls smoothly by default, so scripted scrolls say `behavior: 'instant'`.)
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60)))))
async function resize(page, size) {
  await page.setViewportSize(size)
  await settle(page)
}

/**
 * Sample points of an element, as fractions of its box (from the left, from the top), each
 * inset by at least 4px: centre, right-hand side (where the stack sits on desktop), and the
 * corners.
 */
const POINTS = { centre: [0.5, 0.5], right: [-1, 0.5], topRight: [-1, 0.15], bottomRight: [-1, 0.85], left: [4, 0.5] }

/** For each sample point of `locator`: the testid-or-tag of what is on top there, and whether that is the element or inside it. */
function hitTest(locator, names = Object.keys(POINTS)) {
  return locator.evaluate((el, { points, names }) => {
    const r = el.getBoundingClientRect()
    const out = {}
    for (const name of names) {
      const [fx, fy] = points[name]
      const x = fx < 0 ? r.right - 24 : fx >= 1 ? r.left + fx : r.left + r.width * fx
      const y = r.top + r.height * fy
      const inView = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
      const top = inView ? document.elementFromPoint(x, y) : null
      const stackHit = top ? top.closest('[data-testid="toast-stack"]') : null
      out[name] = { inView, ok: !!top && el.contains(top), coveredByToasts: !!stackHit, topIs: top ? `${top.tagName.toLowerCase()}${top.getAttribute('data-testid') ? `[${top.getAttribute('data-testid')}]` : ''}` : 'nothing' }
    }
    return out
  }, { points: POINTS, names })
}

/** null when every sampled point of `locator` is on screen and on top; else the reason. */
async function uncovered(locator, names) {
  const hits = await hitTest(locator, names)
  const bad = Object.entries(hits).filter(([, v]) => !v.ok)
  if (bad.length === 0) return null
  return bad.map(([n, v]) => `${n}: ${!v.inView ? 'off screen' : v.coveredByToasts ? 'covered by a toast' : `covered by ${v.topIs}`}`).join('; ')
}

/** A check's result from a reason: null (nothing wrong) passes; a string fails with it. */
const verdict = (reason) => (reason === null ? true : reason)

/** Trial click: Playwright's actionability and hit-target checks without clicking. */
async function clickable(locator, options = {}) {
  try {
    await locator.click({ trial: true, timeout: 2500, ...options })
    return null
  } catch (e) {
    return `not clickable: ${String(e.message).split('\n')[0]}`
  }
}

/** Clicks the row at the right-hand point and expects the actions modal; closes it. */
async function clickRowOpensActions(page, row) {
  const box = await row.boundingBox()
  try {
    await row.click({ position: { x: Math.max(4, box.width - 24), y: box.height / 2 }, timeout: 2500 })
  } catch (e) {
    return `row not clickable: ${String(e.message).split('\n')[0]}`
  }
  const close = page.locator('button[aria-label="Close actions modal"]')
  try {
    await close.waitFor({ timeout: 3000 })
  } catch {
    return 'the click did not open the actions modal'
  }
  await close.click()
  await close.waitFor({ state: 'hidden' })
  return null
}

/** Scrolls an open dialog (its overlay) to its end, where its buttons are. */
async function dialogToEnd(page, form) {
  await form.evaluate((el) => {
    const overlay = el.closest('.fixed')
    overlay.scrollTo({ top: overlay.scrollHeight, behavior: 'instant' })
  })
  await settle(page)
}

async function scrollToEnd(page) {
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await settle(page)
}

/** The last row in the list, brought into view. */
async function lastRowInView(page) {
  const row = rows(page).last()
  await row.scrollIntoViewIfNeeded()
  await settle(page)
  return row
}

/**
 * The lowest row fully inside the viewport, clear of the fixed bars and of the toast stack
 * (the stack overlays the scrolling page, so a row under it is not "fully visible"); a locator
 * for it, or null.
 */
async function lowestVisibleRow(page) {
  const index = await page.evaluate(() => {
    const items = [...document.querySelectorAll('article[data-transaction-id]')]
    const bars = [...document.querySelectorAll('nav')].filter((n) => getComputedStyle(n).position === 'fixed' && getComputedStyle(n).display !== 'none')
    const stackEl = document.querySelector('[data-testid="toast-stack"]')
    let floor = window.innerHeight
    let ceiling = 0
    for (const bar of bars) {
      const r = bar.getBoundingClientRect()
      if (r.top > window.innerHeight / 2) floor = Math.min(floor, r.top)
      else ceiling = Math.max(ceiling, r.bottom)
    }
    let best = -1
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      if (r.top < ceiling || r.bottom > floor) return
      if (stackEl) {
        const s = stackEl.getBoundingClientRect()
        const overlaps = r.left < s.right && r.right > s.left && r.top < s.bottom && r.bottom > s.top
        if (overlaps) return
      }
      best = i
    })
    return best
  })
  return index < 0 ? null : rows(page).nth(index)
}

// ─── (a) phone_dialog_button_clear ─────────────────────────────────────────
async function scenarioA(browser) {
  console.log('\n(a) phone_dialog_button_clear: 390x844, 3 pending, Create is uncovered and clicks')
  const { user, checking } = await seedUser('tpa')
  const { ctx, page } = await openPage(browser, user, PHONE)
  try {
    const held = await h.gate(page, isCreate)
    await makePending(page, checking, held, 0, 3, 'TP A')
    await h.check('a.three-pending', 'S', async () => ((await toasts(page).count()) === 3) || `${await toasts(page).count()} toasts`)
    const form = await fillCreate(page, { accountName: checking.name, amount: 999, description: 'TP A Fourth' })
    const create = form.getByRole('button', { name: 'Add transaction', exact: true })
    await dialogToEnd(page, form)
    await shot(page, 'a-dialog')
    const aPlaced = await uncovered(create, ['centre'])
    await h.check('a.create-uncovered', 'B', async () => verdict(aPlaced))
    await h.check('a.create-clickable', 'B', async () => (aPlaced !== null ? 'skipped: the placement check failed' : verdict(await clickable(create))))
    await h.check('a.create-clicks', 'B', async () => {
      if (aPlaced !== null) return 'skipped: the placement check failed'
      await create.click({ timeout: 3000 })
      await form.waitFor({ state: 'hidden', timeout: 5000 })
      return (await toasts(page).count()) === 4 || `${await toasts(page).count()} toasts after the click`
    })
    held.release({ disarm: true })
  } finally {
    await ctx.close()
  }
}

// ─── (b) phone_last_row_clear ──────────────────────────────────────────────
async function scenarioB(browser) {
  console.log('\n(b) phone_last_row_clear: 390x844, 3 pending, dialog closed')
  const { user, checking } = await seedUser('tpb')
  const { ctx, page } = await openPage(browser, user, PHONE)
  try {
    const held = await h.gate(page, isCreate)
    await makePending(page, checking, held, 0, 3, 'TP B')
    const row = await lastRowInView(page)
    await shot(page, 'b-last-row')
    const bPlaced = await uncovered(row)
    await h.check('b.last-row-uncovered', 'B', async () => verdict(bPlaced))
    await h.check('b.last-row-clicks', 'B', async () => (bPlaced !== null ? 'skipped: the placement check failed' : verdict(await clickRowOpensActions(page, row))))
    held.release({ disarm: true })
  } finally {
    await ctx.close()
  }
}

// ─── (c) desktop_last_row_clear ────────────────────────────────────────────
async function scenarioC(browser) {
  console.log('\n(c) desktop_last_row_clear: 1280x800, 3 pending')
  const { user, checking } = await seedUser('tpc')
  const { ctx, page } = await openPage(browser, user, DESKTOP)
  try {
    const held = await h.gate(page, isCreate)
    await makePending(page, checking, held, 0, 3, 'TP C')
    const row = await lastRowInView(page)
    await shot(page, 'c-last-row')
    const cPlaced = await uncovered(row)
    await h.check('c.last-row-uncovered', 'B', async () => verdict(cPlaced))
    await h.check('c.last-row-clicks', 'B', async () => (cPlaced !== null ? 'skipped: the placement check failed' : verdict(await clickRowOpensActions(page, row))))
    held.release({ disarm: true })
  } finally {
    await ctx.close()
  }
}

// ─── (d) toasts_still_usable ───────────────────────────────────────────────
async function readable(page) {
  return page.evaluate(() => {
    const problems = []
    const items = [...document.querySelectorAll('[data-testid="save-toast"]')]
    if (items.length === 0) return 'no toasts'
    for (const el of items) {
      const r = el.getBoundingClientRect()
      const label = (el.textContent || '').trim().slice(0, 30)
      if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) problems.push(`"${label}" is partly off screen`)
      const msg = el.querySelector('[data-testid="save-toast-message"]')
      if (!msg || !(msg.textContent || '').trim()) problems.push(`"${label}" has no message`)
      else if (parseFloat(getComputedStyle(msg).fontSize) < 12) problems.push(`"${label}" text is under 12px`)
      if (el.scrollWidth > el.clientWidth + 1) problems.push(`"${label}" overflows sideways`)
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      if (!top || !el.contains(top)) problems.push(`"${label}" is under something else`)
    }
    return problems.length ? problems.join('; ') : null
  })
}

async function usableAt(browser, size, name) {
  const { user, checking } = await seedUser(`tpd${size.width}`)
  const { ctx, page } = await openPage(browser, user, size)
  try {
    const held = await h.gate(page, isCreate)
    await makePending(page, checking, held, 0, 3, `TP D${size.width}`)
    await h.check(`d.${name}.pending-readable`, 'B', async () => verdict(await readable(page)))
    await shot(page, `d-${name}-pending`)
    held.release({ disarm: true })
    for (let i = 1; i <= 3; i++) {
      await h.check(`d.${name}.saved-${i}`, 'B', async () => {
        await toastFor(page, `TP D${size.width} Pending ${i}`).and(page.locator('[data-state="saved"]')).first().waitFor({ timeout: 10000 })
        return true
      })
    }
    // Saved toasts go after 4 s; act on them at once.
    await h.check(`d.${name}.saved-readable`, 'B', async () => verdict(await readable(page)))
    await h.check(`d.${name}.view`, 'B', async () => {
      const view = toastFor(page, `TP D${size.width} Pending 3`).locator(tid('save-toast-view'))
      await view.click({ timeout: 3000 })
      return true
    })
    await h.check(`d.${name}.dismiss`, 'B', async () => {
      const toast = toastFor(page, `TP D${size.width} Pending 2`)
      await toast.locator(tid('save-toast-dismiss')).click({ timeout: 3000 })
      await toast.waitFor({ state: 'detached', timeout: 5000 })
      return true
    })
    await h.check(`d.${name}.undo`, 'B', async () => {
      const toast = toastFor(page, `TP D${size.width} Pending 1`)
      await toast.locator(tid('save-toast-undo')).click({ timeout: 3000 })
      await toast.waitFor({ state: 'detached', timeout: 10000 })
      await h.waitQuiet(page)
      const list = await client.get(user.token, `/transactions/?search=${encodeURIComponent(`TP D${size.width} Pending 1`)}&limit=100`)
      return list.items.length === 0 || 'the row was not removed by Undo'
    })
    // Retry: a create whose answer never reaches the page.
    let dropped = 0
    await page.route((url) => url.pathname.endsWith('/api/v1/transactions/'), async (route, request) => {
      if (request.method() !== 'POST' || dropped > 0) return route.fallback()
      dropped++
      await route.fetch()
      return route.abort('connectionreset')
    })
    await createUI(page, { accountName: checking.name, amount: 777, description: `TP D${size.width} Retry` })
    await h.check(`d.${name}.failed-readable`, 'B', async () => {
      await toastFor(page, `TP D${size.width} Retry`).and(page.locator('[data-state="failed"]')).first().waitFor({ timeout: 10000 })
      return verdict(await readable(page))
    })
    await shot(page, `d-${name}-failed`)
    await h.check(`d.${name}.retry`, 'B', async () => {
      const toast = toastFor(page, `TP D${size.width} Retry`)
      await toast.locator(tid('save-toast-retry')).click({ timeout: 3000 })
      await toast.and(page.locator('[data-state="saved"]')).first().waitFor({ timeout: 10000 })
      return true
    })
  } finally {
    await ctx.close()
  }
}

async function scenarioD(browser) {
  console.log('\n(d) toasts_still_usable: readable, Dismiss, Undo, Retry at 390x844 and 1280x800')
  await usableAt(browser, PHONE, 'phone')
  await usableAt(browser, DESKTOP, 'desktop')
}

// ─── (e)(f)(g) responsive ──────────────────────────────────────────────────
/** Runs `body(width, size, count)` at every width, once with 2 and once with 3 pending saves. */
async function eachWidthAndCount(browser, tag, body, { dialog }) {
  const { user, checking } = await seedUser(tag)
  const { ctx, page } = await openPage(browser, user, DESKTOP)
  try {
    const held = await h.gate(page, isCreate)
    let made = 0
    for (const count of [2, 3]) {
      await resize(page, DESKTOP)
      await makePending(page, checking, held, made, count, `TP ${tag}`)
      made = count
      let form = null
      if (dialog) {
        form = await fillCreate(page, { accountName: checking.name, amount: 321, description: `TP ${tag} Draft` })
      }
      for (const width of WIDTHS) {
        const size = sizeOf(width)
        await resize(page, size)
        await body({ page, width, size, count, form })
      }
      if (form) {
        await resize(page, DESKTOP)
        await form.getByRole('button', { name: 'Cancel', exact: true }).click()
        await form.waitFor({ state: 'hidden' })
      }
    }
    held.release({ disarm: true })
  } finally {
    await ctx.close()
  }
}

async function scenarioE(browser) {
  console.log('\n(e) responsive_dialog_actions_clear: every dialog action button, 2 and 3 pending, all widths')
  await eachWidthAndCount(browser, 'tpe', async ({ page, width, count, form }) => {
    for (const label of ['Add transaction', 'Save and add another', 'Cancel']) {
      await h.check(`e.${count}pending.w${width}.${label.replace(/\W+/g, '-').toLowerCase()}`, 'B', async () => {
        const button = form.getByRole('button', { name: label, exact: true })
        await dialogToEnd(page, form)
        return verdict((await uncovered(button)) ?? (await clickable(button)))
      })
    }
  }, { dialog: true })
}

async function scenarioF(browser) {
  console.log('\n(f) responsive_form_primary_clear: the filled form\'s primary button, 2 and 3 pending, all widths')
  await eachWidthAndCount(browser, 'tpf', async ({ page, width, count, form }) => {
    await h.check(`f.${count}pending.w${width}.primary`, 'B', async () => {
      const button = form.getByRole('button', { name: 'Add transaction', exact: true })
      await dialogToEnd(page, form)
      return verdict((await uncovered(button)) ?? (await clickable(button)))
    })
  }, { dialog: true })
}

async function scenarioG(browser) {
  console.log('\n(g) responsive_visible_row_actions_clear: lowest visible row partway and the last row at the end, 2 and 3 pending, all widths')
  await eachWidthAndCount(browser, 'tpg', async ({ page, width, count }) => {
    await h.check(`g.${count}pending.w${width}.partway`, 'B', async () => {
      // Partway: the sixth row's top just under the top bar.
      await page.evaluate(() => {
        const bar = document.querySelector('nav')
        const ceiling = bar ? bar.getBoundingClientRect().bottom : 0
        const row = document.querySelectorAll('article[data-transaction-id]')[5]
        window.scrollBy({ top: row.getBoundingClientRect().top - ceiling - 8, behavior: 'instant' })
      })
      await settle(page)
      const row = await lowestVisibleRow(page)
      if (!row) return 'no fully visible row partway down the list'
      return verdict((await uncovered(row)) ?? (await clickable(row, { position: { x: 30, y: 12 } })))
    })
    await h.check(`g.${count}pending.w${width}.end`, 'B', async () => {
      await scrollToEnd(page)
      const row = rows(page).last()
      await row.scrollIntoViewIfNeeded()
      await settle(page)
      const hits = await hitTest(row)
      const toastHit = Object.entries(hits).filter(([, v]) => v.coveredByToasts).map(([n]) => n)
      if (toastHit.length) return `the stack covers the last row at ${toastHit.join(', ')}`
      return verdict((await uncovered(row)) ?? (await clickable(row, { position: { x: Math.max(4, (await row.boundingBox()).width - 24), y: 12 } })))
    })
  }, { dialog: false })
}

const SCENARIOS = { a: scenarioA, b: scenarioB, c: scenarioC, d: scenarioD, e: scenarioE, f: scenarioF, g: scenarioG }

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
