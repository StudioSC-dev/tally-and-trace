// Browser checks for the account and category pickers (STU-573, PR 2): the transaction
// form's Account, Destination Account and Category chips. A list of 8 or fewer shows flat
// as before; a longer one shows a quick row (selected, recent, then group order) and a
// toggle that opens the whole list inline, grouped, with a search box.
//
// (3) flat at 8, collapsed at 9; quick row, toggle, panel, search, collapse on a pick and
// focus on the picked chip; (4) each option in the DOM once; (5) a failed save focuses
// the first chip and keeps `aria-describedby` on the group and its buttons; (6) a saved
// create or edit writes the recents, a refused save writes nothing; (7) at 360 x 740 with
// the panel open nothing scrolls sideways and every chip is at least 44 px tall; (8) a
// non-recent account picked by keyboard only; (a) a recent account is one tap with no
// expansion; (b) group headings in ACCOUNT_GROUPS order with Shared last; (c) "No
// matches" and the live count. PR 3, the transaction list's filters: (f1) the Accounts filter
// is multi select behind an "All accounts" chip and sends the picked account_ids; (f2) a
// category name used in two kinds is one choice, selected once, with "All categories" and
// "No category" ahead of the chips; (f3) a selected non-recent account stays in the
// collapsed quick row; (f4) Reset filters clears both pickers; (f5) the 50-name cap and its message. Every scenario checks that
// no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/pickers.cjs [scenario]
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

let stack, client, owner, ownerId, partner, small, filt, cap
/** The owner's 17 writable accounts by name. */
const acct = {}

// Owner's own accounts: every type. Partner shares two more as editor (Shared section).
const OWN = [
  ['P Bdo Savings', 'savings'], ['P Bpi Checking', 'checking'], ['P Union Checking', 'checking'], ['P Wise USD', 'savings', 'USD'],
  ['P Bpi Visa', 'credit'], ['P Metrobank MC', 'credit'], ['P Rcbc JCB', 'credit'],
  ['P GCash', 'e_wallet'], ['P Maya', 'e_wallet'], ['P Café Wallet', 'e_wallet'], ['P Coins Wallet', 'e_wallet'],
  ['P Cash', 'cash'], ['P Petty Cash', 'cash'],
  ['P Car Loan', 'loan'], ['P Home Loan', 'loan'],
]
const SHARED = [['P Joint Household', 'checking'], ['P Joint Card', 'credit']]
const WANT_HEADINGS = ['Debit', 'Credit', 'E-wallet', 'Cash', 'Loan', 'Shared', 'Debit', 'Credit']

const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/transactions')

const formModal = (page, heading) =>
  page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
const field = (form, key) => form.locator(`[data-field="${key}"]`)
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const toggleOf = (group) => group.locator('[data-picker-toggle]')
// The dialog's pickers are compact (STU-580): a field with a value is one line until Change opens it.
const changeOf = (group) => group.locator('[data-picker-change]')
const reopen = async (group) => {
  if ((await group.locator('[data-picker-change][aria-expanded="false"]').count()) === 1) await changeOf(group).click()
}
const fieldError = (modal, key) => modal.locator(`[data-testid="field-error-${key}"]`)
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement).catch(() => false)
const activeText = (page) => page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.tagName || '').trim())
/** The option ids rendered in a picker, in DOM order. */
const idsIn = (group) => group.locator('[data-picker-id]').evaluateAll((els) => els.map((el) => el.getAttribute('data-picker-id')))
const namesIn = (group) => group.locator('[data-picker-id]').evaluateAll((els) => els.map((el) => el.childNodes[0]?.textContent?.trim() ?? ''))
const dupes = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i)

const loanBody = (name) => ({
  name, account_type: 'loan', loan_kind: 'auto', balance: -100000, currency: 'PHP',
  loan_annual_rate: 12, loan_term_months: 24, loan_payment_amount: 5000,
  loan_first_payment_date: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10),
})
const accountBody = (name, type, currency = 'PHP') =>
  type === 'loan'
    ? loanBody(name)
    : { name, account_type: type, balance: 1000, currency, ...(type === 'credit' ? { credit_limit: 100000 } : {}) }

/** A fresh signed-in page on Transactions (optionally at a viewport), native dialogs tracked. */
async function openTransactions(browser, user = owner, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const creates = []
  page.on('request', (r) => {
    if (isCreate(r)) {
      try { creates.push(JSON.parse(r.postData() || 'null')) } catch { creates.push(null) }
    }
  })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, creates }
}

async function openAddForm(page) {
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page, 'Create Transaction')
  await modal.waitFor()
  await h.waitQuiet(page)
  await control(modal, 'account_id').locator('button').first().waitFor()
  return modal
}

const submit = async (page, modal) => {
  await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
  await page.waitForTimeout(300)
  await h.waitQuiet(page)
}

const recentKey = (kind) => `tt:recent:${ownerId}:${kind}`
const readRecent = (page, kind) =>
  page.evaluate((key) => { try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return 'unreadable' } }, recentKey(kind))
const writeRecent = (page, kind, ids) =>
  page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [recentKey(kind), ids])

// (3) Flat at 8, collapsed at 9; the quick row, the toggle, the panel and a pick from it.
async function scenario3(browser) {
  console.log('\n=== (3) 8 or fewer stay flat; more get a quick row, a toggle and an inline panel')
  {
    const { ctx, page, native } = await openTransactions(browser, small.user)
    try {
      let modal = await openAddForm(page)
      let group = control(modal, 'account_id')
      await h.check('3.flat.mode', 'B', async () => (await group.getAttribute('data-picker')) === 'flat' || `data-picker ${await group.getAttribute('data-picker')}`)
      await h.check('3.flat.no-toggle-no-search', 'B', async () => {
        const n = [await toggleOf(group).count(), await group.locator('input[type="search"]').count()]
        return (n[0] === 0 && n[1] === 0) || `toggle, search ${JSON.stringify(n)}`
      })
      await h.check('3.flat.all-eight-in-api-order', 'B', async () => {
        const list = await client.get(small.user.token, '/accounts/?is_active=true&limit=100')
        const items = Array.isArray(list) ? list : list.items
        const want = items.map((a) => String(a.id))
        const got = await idsIn(group)
        return (got.length === 8 && JSON.stringify(got) === JSON.stringify(want)) || `chips ${JSON.stringify(got)}, API ${JSON.stringify(want)}`
      })
      await h.check('3.flat.category-transfer-flat', 'B', async () => {
        await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
        const cat = control(modal, 'category_id')
        await reopen(cat)
        const got = { mode: await cat.getAttribute('data-picker'), chips: (await idsIn(cat)).length, first: (await cat.locator('[data-picker-leading]').first().textContent()).trim() }
        return (got.mode === 'flat' && got.chips === 3 && got.first === 'None') || JSON.stringify(got)
      })
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
      await client.post(small.user.token, '/accounts/', accountBody('S Ninth', 'cash'))
      await page.reload()
      await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
      await h.waitQuiet(page)
      modal = await openAddForm(page)
      group = control(modal, 'account_id')
      await h.check('3.nine.collapsed', 'B', async () => {
        const got = { mode: await group.getAttribute('data-picker'), toggle: (await toggleOf(group).textContent().catch(() => '')).trim() }
        return (got.mode === 'collapsed' && got.toggle.startsWith('All 9 accounts')) || JSON.stringify(got)
      })
    } finally {
      await d.checkNoNativeDialogs(h, '3.small', native)
      await ctx.close()
    }
  }

  const { ctx, page, native } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    const toggle = toggleOf(group)
    await h.check('3.collapsed', 'B', async () => {
      const got = {
        mode: await group.getAttribute('data-picker'),
        chips: (await idsIn(group)).length,
        toggle: (await toggle.textContent()).trim(),
        expanded: await toggle.getAttribute('aria-expanded'),
        search: await group.locator('input[type="search"]').count(),
      }
      return (got.mode === 'collapsed' && got.chips === 5 && got.toggle.startsWith('All 17 accounts') && got.expanded === 'false' && got.search === 0) || JSON.stringify(got)
    })
    await h.check('3.toggle-controls', 'B', async () => {
      const controls = await toggle.getAttribute('aria-controls')
      return !!controls || 'no aria-controls'
    })
    await h.check('3.target-not-in-quick-row', 'S', async () =>
      (await chipOf(group, 'P Home Loan').count()) === 0 || 'P Home Loan is already in the quick row')
    await toggle.click()
    await h.check('3.expanded', 'B', async () => {
      const controls = await toggle.getAttribute('aria-controls')
      const got = {
        mode: await group.getAttribute('data-picker'),
        chips: (await idsIn(group)).length,
        toggle: (await toggle.textContent()).trim(),
        expanded: await toggle.getAttribute('aria-expanded'),
        search: await group.locator('input[type="search"]').count(),
        panel: await group.locator(`[id="${controls}"]`).count(),
      }
      return (got.mode === 'expanded' && got.chips === 17 && got.toggle.startsWith('Show fewer') && got.expanded === 'true' && got.search === 1 && got.panel === 1) || JSON.stringify(got)
    })
    await chipOf(group, 'P Home Loan').click()
    await h.check('3.pick-collapses', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), chips: (await idsIn(group)).length, line: ((await group.locator('[data-picker-value]').textContent()) || '').trim() }
      return (got.mode === 'line' && got.chips === 0 && got.line === 'P Home Loan (PHP)') || JSON.stringify(got)
    })
    await h.check('3.focus-on-change', 'B', async () => (await isFocused(changeOf(group))) || `active ${await activeText(page)}`)
    await changeOf(group).click()
    const picked = chipOf(group, 'P Home Loan')
    await h.check('3.picked-selected-first', 'B', async () => {
      const ids = await idsIn(group)
      return ((await picked.getAttribute('data-selected')) === 'true' && ids[0] === String(acct['P Home Loan'].id)) || `quick row ${JSON.stringify(await namesIn(group))}`
    })
    await h.check('3.recording-in', 'B', async () => {
      const text = await modal.getByText(/^Recording in /).textContent().catch(() => '')
      return text.includes('PHP') || `recording line ${JSON.stringify(text)}`
    })
    // The category picker: 15 expense categories, "Uncategorized" first.
    const cat = control(modal, 'category_id')
    await reopen(cat)
    await h.check('3.category-collapsed', 'B', async () => {
      const got = {
        mode: await cat.getAttribute('data-picker'),
        first: (await cat.locator('[data-picker-leading]').first().textContent()).trim(),
        toggle: (await toggleOf(cat).textContent()).trim(),
      }
      return (got.mode === 'collapsed' && got.first === 'Uncategorized' && got.toggle.startsWith('All 15 categories')) || JSON.stringify(got)
    })
    await pick(cat, 'Travel')
    await reopen(cat)
    await h.check('3.category-picked', 'B', async () =>
      (await chipOf(cat, 'Travel').getAttribute('data-selected')) === 'true' && (await cat.getAttribute('data-picker')) === 'collapsed' || 'Travel not selected in the collapsed row')
    await chipOf(cat, 'Uncategorized').click()
    await reopen(cat)
    await h.check('3.uncategorized-leading', 'B', async () =>
      (await chipOf(cat, 'Uncategorized').getAttribute('data-selected')) === 'true' || 'Uncategorized not selected')
    // The destination: tap again clears.
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    const dest = control(modal, 'transfer_to_account_id')
    await h.check('3.destination-excludes-source', 'B', async () => {
      await toggleOf(dest).click()
      const names = await namesIn(dest)
      await toggleOf(dest).click()
      return (names.length === 16 && !names.includes('P Home Loan')) || `destination options ${names.length}: ${JSON.stringify(names)}`
    })
    await pick(dest, 'P Maya')
    await reopen(dest)
    await h.check('3.destination-picked', 'B', async () => (await chipOf(dest, 'P Maya').getAttribute('data-selected')) === 'true' || 'P Maya not selected')
    await chipOf(dest, 'P Maya').click()
    await h.check('3.destination-cleared-on-retap', 'B', async () => {
      const n = await dest.locator('[data-selected="true"]').count()
      return n === 0 || `${n} selected`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '3', native)
    await ctx.close()
  }
}

// (4) Each option is in the DOM once: collapsed, expanded and while searching.
async function scenario4(browser) {
  console.log('\n=== (4) Each option is rendered exactly once')
  const { ctx, page, native } = await openTransactions(browser)
  try {
    await writeRecent(page, 'account', [acct['P Maya'].id, acct['P Cash'].id])
    await page.reload()
    await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
    await h.waitQuiet(page)
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    await pick(group, 'P Maya')
    await reopen(group)
    const states = {}
    states.collapsed = await idsIn(group)
    await toggleOf(group).click()
    states.expanded = await idsIn(group)
    await group.locator('input[type="search"]').fill('p')
    states.search = await idsIn(group)
    const cat = control(modal, 'category_id')
    await reopen(cat)
    await toggleOf(cat).click()
    states.categories = await idsIn(cat)
    for (const [name, ids] of Object.entries(states)) {
      await h.check(`4.${name}.unique`, 'B', async () => dupes(ids).length === 0 || `duplicates ${JSON.stringify(dupes(ids))}`)
    }
    await h.check('4.expanded.complete', 'B', async () => states.expanded.length === 17 || `${states.expanded.length} chips`)
    await h.check('4.categories.complete', 'B', async () => states.categories.length === 15 || `${states.categories.length} chips`)
    await h.check('4.collapsed.selected-and-recents-once', 'B', async () => {
      const [maya, cash] = [String(acct['P Maya'].id), String(acct['P Cash'].id)]
      return (states.collapsed[0] === maya && states.collapsed[1] === cash && states.collapsed.length === 5) || `quick row ${JSON.stringify(states.collapsed)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '4', native)
    await ctx.close()
  }
}

// (5) A failed save focuses the first chip; aria-describedby on the group and its buttons.
async function scenario5(browser) {
  console.log('\n=== (5) No account: the error focuses the first chip, collapsed and expanded')
  const { ctx, page, native, creates } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    await control(modal, 'description').fill('Picker five')
    await control(modal, 'amount').fill('12')
    for (const state of ['collapsed', 'expanded']) {
      if (state === 'expanded') await toggleOf(group).click()
      await submit(page, modal)
      await fieldError(modal, 'account_id').waitFor({ timeout: 3000 }).catch(() => {})
      await h.check(`5.${state}.message`, 'B', async () => {
        const text = ((await fieldError(modal, 'account_id').textContent().catch(() => '')) || '').trim()
        return text === 'Please select an account for this transaction.' || `error ${JSON.stringify(text)}`
      })
      await h.check(`5.${state}.focus-first-chip`, 'B', async () => {
        const first = group.locator('button:not([data-picker-toggle])').first()
        const got = await first.evaluate((el) => ({ id: el.getAttribute('data-picker-id'), active: el === document.activeElement }))
        return (got.id !== null && got.active) || `first button ${JSON.stringify(got)}, active ${await activeText(page)}`
      })
      await h.check(`5.${state}.described`, 'B', async () => {
        const errorId = await fieldError(modal, 'account_id').getAttribute('id')
        const groupDesc = await group.getAttribute('aria-describedby')
        const buttons = await group.locator('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-describedby')))
        return (!!errorId && groupDesc === errorId && buttons.length > 0 && buttons.every((id) => id === errorId)) || `group ${groupDesc}, buttons ${JSON.stringify(buttons)}, error ${errorId}`
      })
    }
    await h.check('5.no-post', 'B', async () => creates.length === 0 || `${creates.length} POST(s)`)
    // A transfer with no destination focuses the destination's first chip.
    await pick(group, 'P Bpi Checking')
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    await submit(page, modal)
    const dest = control(modal, 'transfer_to_account_id')
    await fieldError(modal, 'transfer_to_account_id').waitFor({ timeout: 3000 }).catch(() => {})
    await h.check('5.destination.focus-first-chip', 'B', async () => {
      const got = await dest.locator('button').first().evaluate((el) => ({ id: el.getAttribute('data-picker-id'), active: el === document.activeElement }))
      return (got.id !== null && got.active) || `first button ${JSON.stringify(got)}, active ${await activeText(page)}`
    })
    await pick(dest, 'P Maya')
    await h.check('5.destination.cleared-on-pick', 'B', async () =>
      (await fieldError(modal, 'transfer_to_account_id').count()) === 0 || 'the destination error is still shown')
  } finally {
    await d.checkNoNativeDialogs(h, '5', native)
    await ctx.close()
  }
}

// (6) Recents: written after a saved create or edit, never after a refused save.
async function scenario6(browser) {
  console.log('\n=== (6) A saved create or edit writes the recents; a refused save writes nothing')
  const { ctx, page, native, creates } = await openTransactions(browser)
  try {
    await h.check('6.empty-at-start', 'S', async () => {
      const got = [await readRecent(page, 'account'), await readRecent(page, 'category')]
      return (got[0] === null && got[1] === null) || JSON.stringify(got)
    })
    // A refused save writes nothing.
    let modal = await openAddForm(page)
    await control(modal, 'description').fill('Picker refused')
    await pick(control(modal, 'account_id'), 'P Rcbc JCB')
    await pick(control(modal, 'category_id'), 'Travel')
    await control(modal, 'amount').fill('30')
    const fail = await h.failWith(page, isCreate, 500, { times: 1 })
    await submit(page, modal)
    await modal.locator('[data-testid="transaction-form-error"]').waitFor({ timeout: 5000 }).catch(() => {})
    await fail.stop()
    await h.check('6.refused.sent', 'S', async () => fail.failed === 1 || `${fail.failed} refused`)
    await h.check('6.refused.nothing-written', 'B', async () => {
      const got = [await readRecent(page, 'account'), await readRecent(page, 'category')]
      return (got[0] === null && got[1] === null) || JSON.stringify(got)
    })
    // The same form saved: account and category written.
    await h.waitQuiet(page)
    await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.waitQuiet(page)
    await h.check('6.create.written', 'B', async () => {
      const got = [await readRecent(page, 'account'), await readRecent(page, 'category')]
      const travel = (await client.get(owner.token, '/categories/')).find((c) => c.name === 'Travel')
      return (JSON.stringify(got[0]) === JSON.stringify([acct['P Rcbc JCB'].id]) && JSON.stringify(got[1]) === JSON.stringify([travel.id])) || JSON.stringify(got)
    })
    // A transfer: the source newest, then the destination.
    modal = await openAddForm(page)
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    await control(modal, 'description').fill('Picker transfer')
    await pick(control(modal, 'account_id'), 'P GCash')
    await pick(control(modal, 'transfer_to_account_id'), 'P Petty Cash')
    await control(modal, 'amount').fill('40')
    await submit(page, modal)
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.waitQuiet(page)
    await h.check('6.transfer.written', 'B', async () => {
      const got = await readRecent(page, 'account')
      const want = [acct['P GCash'].id, acct['P Petty Cash'].id, acct['P Rcbc JCB'].id]
      return JSON.stringify(got) === JSON.stringify(want) || `account recents ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
    })
    await h.check('6.creates', 'S', async () => creates.length === 3 || `${creates.length} POST(s)`)
    // An edit that moves the row to another account.
    await page.locator('article[role="button"]').filter({ hasText: 'Picker refused' }).first().click()
    const actions = formModal(page, 'Transaction Actions')
    await actions.waitFor()
    await h.waitQuiet(page)
    await actions.getByRole('button', { name: 'Edit Transaction', exact: true }).click()
    const edit = formModal(page, 'Edit Transaction')
    await edit.waitFor()
    await h.waitQuiet(page)
    await pick(control(edit, 'account_id'), 'P Coins Wallet')
    await edit.getByRole('button', { name: /^(Update|Save)/ }).first().click()
    await edit.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.waitQuiet(page)
    await h.check('6.edit.written', 'B', async () => {
      const got = await readRecent(page, 'account')
      return (Array.isArray(got) && got[0] === acct['P Coins Wallet'].id) || `account recents ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '6', native)
    await ctx.close()
  }
}

// (7) Phone: 360 x 740, panel open, no sideways scroll, every chip at least 44 px tall.
async function scenario7(browser) {
  console.log('\n=== (7) 360 x 740: no sideways scroll and 44 px chips with the panel open')
  const { ctx, page, native } = await openTransactions(browser, owner, { viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    const measure = async () => page.evaluate(() => {
      const wide = []
      const doc = document.scrollingElement
      if (doc.scrollWidth > doc.clientWidth + 1) wide.push(`document ${doc.scrollWidth}>${doc.clientWidth}`)
      for (const el of document.querySelectorAll('div.fixed, div.fixed *')) {
        if (el.closest('[data-picker-row]')) continue // the compact chip row scrolls sideways by design
        const style = getComputedStyle(el)
        if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) wide.push(`${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`)
      }
      const outside = [...document.querySelectorAll('[data-picker] button')].filter((b) => !b.closest('[data-picker-row]')).filter((b) => {
        const r = b.getBoundingClientRect()
        return r.left < -0.5 || r.right > window.innerWidth + 0.5
      }).map((b) => b.textContent.trim())
      const short = [...document.querySelectorAll('[data-picker] button')]
        .map((b) => ({ name: b.textContent.trim(), h: b.getBoundingClientRect().height }))
        .filter((x) => x.h < 44)
      const n = document.querySelectorAll('[data-picker] button').length
      return { wide, outside, short, n }
    })
    for (const state of ['collapsed', 'expanded']) {
      if (state === 'expanded') {
        await toggleOf(group).click()
        await reopen(cat)
        await toggleOf(cat).click()
      }
      const got = await measure()
      await h.check(`7.${state}.no-sideways-scroll`, 'B', async () =>
        (got.wide.length === 0 && got.outside.length === 0) || `wide ${JSON.stringify(got.wide)}, outside ${JSON.stringify(got.outside)}`)
      await h.check(`7.${state}.chips-44px`, 'B', async () =>
        (got.n > 0 && got.short.length === 0) || `${got.short.length} of ${got.n} below 44 px: ${JSON.stringify(got.short.slice(0, 5))}`)
    }
    await h.check('7.expanded.all-17', 'S', async () => (await idsIn(group)).length === 17 || 'the panel is not open')
    await pick(group, 'P Joint Card')
    await reopen(group)
    await h.check('7.tap-picks', 'B', async () =>
      (await chipOf(group, 'P Joint Card').getAttribute('data-selected')) === 'true' || 'P Joint Card not selected')
  } finally {
    await d.checkNoNativeDialogs(h, '7', native)
    await ctx.close()
  }
}

// (8) Keyboard only: Tab to the toggle, Enter, Tab to search, type, Enter on the one match.
async function scenario8(browser) {
  console.log('\n=== (8) Keyboard only: a non-recent account by Tab, Enter and typing')
  const { ctx, page, native, creates } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    const toggle = toggleOf(group)
    await h.check('8.target-not-in-quick-row', 'S', async () =>
      (await chipOf(group, 'P Metrobank MC').count()) === 0 || 'P Metrobank MC is already in the quick row')
    await control(modal, 'description').focus()
    await page.keyboard.type('Picker keys')
    let reached = false
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await isFocused(toggle)
    }
    await h.check('8.tab-reaches-toggle', 'B', async () => reached || `active ${await activeText(page)}`)
    await page.keyboard.press('Enter')
    await h.check('8.enter-expands', 'B', async () => (await toggle.getAttribute('aria-expanded')) === 'true' || 'not expanded')
    await h.check('8.focus-stays-on-toggle', 'B', async () => (await isFocused(toggle)) || `active ${await activeText(page)}`)
    await page.keyboard.press('Tab')
    const search = group.locator('input[type="search"]')
    await h.check('8.tab-to-search', 'B', async () => (await isFocused(search)) || `active ${await activeText(page)}`)
    // Escape clears the search, then collapses and returns focus to the toggle.
    await page.keyboard.type('zz')
    await page.keyboard.press('Escape')
    await h.check('8.escape-clears', 'B', async () =>
      ((await search.inputValue()) === '' && (await isFocused(search))) || `search ${JSON.stringify(await search.inputValue())}`)
    await page.keyboard.press('Escape')
    await h.check('8.escape-collapses', 'B', async () =>
      ((await toggle.getAttribute('aria-expanded')) === 'false' && (await isFocused(toggle)) && (await modal.count()) === 1) || `expanded ${await toggle.getAttribute('aria-expanded')}, active ${await activeText(page)}`)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    // Two matches: Enter picks nothing.
    await page.keyboard.type('m')
    await page.keyboard.press('Enter')
    await h.check('8.enter-many-no-pick', 'B', async () => {
      const n = await group.locator('[data-selected="true"]').count()
      return (n === 0 && creates.length === 0 && (await toggle.getAttribute('aria-expanded')) === 'true') || `${n} selected, ${creates.length} POST(s)`
    })
    await page.keyboard.type('etro')
    await page.keyboard.press('Enter')
    const line = group.locator('[data-picker-value]')
    await h.check('8.enter-one-picks', 'B', async () =>
      ((await line.textContent()) === 'P Metrobank MC (PHP)' && (await group.getAttribute('data-picker')) === 'line') || 'P Metrobank MC not picked')
    await h.check('8.focus-on-change', 'B', async () => (await isFocused(changeOf(group))) || `active ${await activeText(page)}`)
    await h.check('8.no-submit', 'B', async () => creates.length === 0 || `${creates.length} POST(s) from Enter`)
  } finally {
    await d.checkNoNativeDialogs(h, '8', native)
    await ctx.close()
  }
}

// (a) A recent account is one tap, with no expansion.
async function scenarioA(browser) {
  console.log('\n=== (a) A recent account is selected with one tap and no expansion')
  const { ctx, page, native } = await openTransactions(browser)
  try {
    let modal = await openAddForm(page)
    await control(modal, 'description').fill('Picker recent')
    await pick(control(modal, 'account_id'), 'P Petty Cash')
    await control(modal, 'amount').fill('15')
    await submit(page, modal)
    await modal.waitFor({ state: 'detached', timeout: 6000 }).catch(() => {})
    await h.waitQuiet(page)
    modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    const recent = chipOf(group, 'P Petty Cash')
    await h.check('a.recent-in-quick-row', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), n: await recent.count(), first: (await namesIn(group))[0] }
      return (got.mode === 'collapsed' && got.n === 1 && got.first === 'P Petty Cash') || JSON.stringify(got)
    })
    await recent.click()
    await h.check('a.one-tap', 'B', async () => {
      const got = { line: ((await group.locator('[data-picker-value]').textContent()) || '').trim(), toggles: await toggleOf(group).count(), mode: await group.getAttribute('data-picker') }
      return (got.line === 'P Petty Cash (PHP)' && got.toggles === 0 && got.mode === 'line') || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) Group headings in ACCOUNT_GROUPS order, Shared last with its own type groups; names sorted.
async function scenarioB(browser) {
  console.log('\n=== (b) Group headings in order, Shared last, names sorted inside a group')
  const { ctx, page, native } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    await toggleOf(group).click()
    await h.check('b.headings', 'B', async () => {
      const got = await group.locator('[data-picker-heading]').evaluateAll((els) => els.map((el) => el.textContent.trim()))
      return JSON.stringify(got) === JSON.stringify(WANT_HEADINGS) || `headings ${JSON.stringify(got)}`
    })
    await h.check('b.shared-nested', 'B', async () => {
      const got = await group.locator('[data-picker-group="shared"] [data-picker-id]').evaluateAll((els) => els.map((el) => el.childNodes[0].textContent.trim()))
      return JSON.stringify(got) === JSON.stringify(['P Joint Household', 'P Joint Card']) || `shared ${JSON.stringify(got)}`
    })
    await h.check('b.sorted-in-group', 'B', async () => {
      const got = await group.locator('[data-picker-group="e_wallet"] [data-picker-id]').evaluateAll((els) => els.map((el) => el.childNodes[0].textContent.trim()))
      return JSON.stringify(got) === JSON.stringify(['P Café Wallet', 'P Coins Wallet', 'P GCash', 'P Maya']) || `e-wallet ${JSON.stringify(got)}`
    })
    await h.check('b.group-labelled', 'B', async () => {
      const label = await group.locator('[data-picker-group="credit"]').evaluate((el) =>
        document.getElementById(el.getAttribute('aria-labelledby') || '')?.textContent?.trim() ?? null)
      return label === 'Credit' || `credit group label ${label}`
    })
    await h.check('b.currency-hint', 'B', async () => {
      const text = (await chipOf(group, 'P Wise USD').textContent()).trim()
      return text === 'P Wise USD(USD)' || `chip ${JSON.stringify(text)}`
    })
    await h.check('b.category-no-heading', 'B', async () => {
      const cat = control(modal, 'category_id')
      await reopen(cat)
      await toggleOf(cat).click()
      const n = await cat.locator('[data-picker-heading]').count()
      return n === 0 || `${n} headings for one kind`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) Search: the live count, "No matches", accents, and empty groups hidden.
async function scenarioC(browser) {
  console.log('\n=== (c) Search: the live count and "No matches"')
  const { ctx, page, native } = await openTransactions(browser)
  try {
    const modal = await openAddForm(page)
    const group = control(modal, 'account_id')
    await toggleOf(group).click()
    const search = group.locator('input[type="search"]')
    const live = group.locator('[data-picker-matches]')
    await h.check('c.live-polite', 'B', async () => (await live.getAttribute('aria-live')) === 'polite' || 'not aria-live=polite')
    const cases = [
      ['bpi', '2 matches', ['P Bpi Checking', 'P Bpi Visa'], ['Debit', 'Credit']],
      ['cafe', '1 match', ['P Café Wallet'], ['E-wallet']],
      ['joint', '2 matches', ['P Joint Household', 'P Joint Card'], ['Shared', 'Debit', 'Credit']],
      ['zzz', 'No matches', [], []],
    ]
    for (const [q, text, names, headings] of cases) {
      await search.fill(q)
      await h.check(`c.${q}`, 'B', async () => {
        const got = {
          text: ((await live.textContent()) || '').trim(),
          names: await namesIn(group),
          headings: await group.locator('[data-picker-heading]').evaluateAll((els) => els.map((el) => el.textContent.trim())),
        }
        const ok = got.text === text && JSON.stringify(got.names) === JSON.stringify(names) && JSON.stringify(got.headings) === JSON.stringify(headings)
        return ok || JSON.stringify(got)
      })
    }
    await search.fill('')
    await h.check('c.cleared', 'B', async () => {
      const got = { text: ((await live.textContent()) || '').trim(), n: (await idsIn(group)).length }
      return (got.text === '' && got.n === 17) || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }
}

// ---- PR 3: the transaction list's filters (Accounts, Categories) ----------------------------

const listRequests = (page) => {
  const seen = []
  page.on('request', (r) => {
    if (r.method() === 'GET' && pathOf(r.url()).endsWith('/transactions')) {
      const u = new URL(r.url())
      seen.push({ accounts: u.searchParams.getAll('account_ids'), names: u.searchParams.getAll('category_names'), none: u.searchParams.get('uncategorized') })
    }
  })
  return seen
}
const filterGroup = (page, key) => page.locator(`[data-field="${key}"]`)
const filtersTab = async (page) => {
  await page.getByRole('button', { name: 'Show filters' }).click()
  await h.waitQuiet(page)
  await filterGroup(page, 'filter_accounts').waitFor()
}
const selectedIn = (group) => group.locator('[data-picker-id][data-selected="true"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-picker-id')))
const lastReq = (seen) => seen[seen.length - 1]
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
async function openFilters(browser) {
  const t = await openTransactions(browser, filt.user)
  t.seen = listRequests(t.page)
  await filtersTab(t.page)
  return t
}

// (f1) The Accounts filter: "All accounts" leading chip, multi select, and the account_ids on the wire.
async function scenarioF1(browser) {
  console.log('\n=== (f1) Accounts filter: multi select over the grouped picker; account_ids on the wire')
  const { ctx, page, native, seen } = await openFilters(browser)
  try {
    const group = filterGroup(page, 'filter_accounts')
    const all = group.locator('[data-picker-leading="all"]')
    await h.check('f1.collapsed-with-all-chip-selected', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), all: await all.getAttribute('data-selected'), disabled: await all.isDisabled(), toggle: ((await toggleOf(group).textContent()) || '').trim() }
      return (got.mode === 'collapsed' && got.all === 'true' && got.disabled && /^All 10 accounts/.test(got.toggle)) || JSON.stringify(got)
    })
    await pick(group, 'F Wise USD')
    await h.waitQuiet(page)
    await pick(group, 'F Maya')
    await h.waitQuiet(page)
    await h.check('f1.two-accounts-on-the-wire', 'B', async () => {
      const want = [String(filt.acct['F Wise USD'].id), String(filt.acct['F Maya'].id)]
      const got = lastReq(seen)
      return (sameSet(got.accounts, want)) || JSON.stringify({ got, want })
    })
    await h.check('f1.panel-stays-open-all-chip-off', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), all: await all.getAttribute('data-selected'), count: ((await group.locator('[data-picker-count]').textContent()) || '').trim() }
      return (got.mode === 'expanded' && got.all === null && got.count === '2 selected') || JSON.stringify(got)
    })
    await chipOf(group, 'F Wise USD').click()
    await h.waitQuiet(page)
    await h.check('f1.untoggle-removes-one', 'B', async () => {
      const got = lastReq(seen).accounts
      return sameSet(got, [String(filt.acct['F Maya'].id)]) || JSON.stringify(got)
    })
    await all.click()
    await h.waitQuiet(page)
    await h.check('f1.all-accounts-clears', 'B', async () => {
      const got = { req: lastReq(seen).accounts, sel: await selectedIn(group), all: await all.getAttribute('data-selected') }
      return (got.req.length === 0 && got.sel.length === 0 && got.all === 'true') || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f1', native)
    await ctx.close()
  }
}

// ---- PR 4: the allocation form (C6 tracked categories, C7 accounts to aggregate) ----

const isAllocationCreate = (r) => r.method() === 'POST' && pathOf(r.url()).endsWith('/allocations')
const budgetForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Budget Envelope' }) })
const savingsForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Create Savings Tracker' }) })
const headingsOf = (group) => group.locator('[data-picker-heading]').evaluateAll((els) => els.map((el) => el.textContent.trim()))

async function openAllocationForm(browser, tab, formOf) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const creates = []
  page.on('request', (r) => {
    if (isAllocationCreate(r)) {
      try { creates.push(JSON.parse(r.postData() || 'null')) } catch { creates.push(null) }
    }
  })
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: tab, exact: true }).waitFor()
  await h.waitQuiet(page)
  await page.getByRole('button', { name: tab, exact: true }).click()
  await h.waitQuiet(page)
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  const form = formOf(page)
  await form.waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, creates, form }
}

// (g1) Tracked Categories: grouped by kind, multi select that stays open, ids in the POST body.
async function scenarioG1(browser) {
  console.log('\n=== (g1) Tracked Categories: Expense, Income and Transfer headings; the picked category_ids are sent')
  const { ctx, page, native, creates, form } = await openAllocationForm(browser, 'Budgets', budgetForm)
  try {
    const group = control(form, 'category_ids')
    const cats = await client.get(owner.token, '/categories/')
    const idOf = (name) => cats.find((c) => c.name === name).id
    await h.check('g1.collapsed-with-toggle', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), toggle: await toggleOf(group).textContent() }
      return (got.mode === 'collapsed' && /^All 23 categories/.test(got.toggle)) || JSON.stringify(got)
    })
    await pick(group, 'Utilities')
    await pick(group, 'Salary')
    await h.check('g1.headings', 'B', async () => {
      const got = await headingsOf(group)
      return JSON.stringify(got) === JSON.stringify(['Expense', 'Income', 'Transfer']) || `headings ${JSON.stringify(got)}`
    })
    await h.check('g1.stays-open-multi', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), expanded: await toggleOf(group).getAttribute('aria-expanded') }
      return (got.mode === 'expanded' && got.expanded === 'true') || JSON.stringify(got)
    })
    await chipOf(group, 'Debt Payments').click()
    await h.check('g1.selected-marked', 'B', async () => {
      const got = await group.locator('[data-selected="true"]').evaluateAll((els) => els.map((el) => el.childNodes[0].textContent.trim()).sort())
      return JSON.stringify(got) === JSON.stringify(['Debt Payments', 'Salary', 'Utilities']) || `selected ${JSON.stringify(got)}`
    })
    await chipOf(group, 'Salary').click()
    await field(form, 'account_id').selectOption(String(acct['P Bdo Savings'].id))
    await field(form, 'name').fill('Picker G1 envelope')
    await field(form, 'target_amount').fill('1000')
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    await page.getByLabel('Close allocation modal').waitFor({ state: 'detached', timeout: 6000 }).catch(() => null)
    await h.check('g1.post-body-category-ids', 'B', async () => {
      const ids = creates.length === 1 ? (creates[0]?.configuration?.category_ids ?? null) : null
      const want = [idOf('Utilities'), idOf('Debt Payments')].sort((a, b) => a - b)
      return (Array.isArray(ids) && JSON.stringify([...ids].sort((a, b) => a - b)) === JSON.stringify(want)) || `posts ${creates.length}, body ${JSON.stringify(creates[0])}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'g1', native)
    await ctx.close()
  }
}

// (f2) The Categories filter: a name used in two kinds is one choice, selected once.
async function scenarioF2(browser) {
  console.log('\n=== (f2) Categories filter: a name shared across kinds is selected once; All categories and No category')
  const { ctx, page, native, seen } = await openFilters(browser)
  try {
    const group = filterGroup(page, 'filter_categories')
    await h.check('f2.toggle-counts-names-not-rows', 'B', async () => {
      const names = new Set((await client.get(filt.user.token, '/categories/')).filter((c) => c.is_active !== false).map((c) => c.name))
      const text = ((await toggleOf(group).textContent()) || '').trim()
      return text.startsWith(`All ${names.size} categories`) || `toggle "${text}", ${names.size} distinct names`
    })
    await toggleOf(group).click()
    const both = group.locator('[data-picker-id="F Both"]')
    await h.check('f2.listed-under-both-kinds', 'B', async () => {
      const heads = await both.evaluateAll((els) => els.map((el) => el.closest('[data-picker-group]')?.getAttribute('data-picker-group')))
      return (heads.length === 2 && heads.includes('expense') && heads.includes('income')) || JSON.stringify(heads)
    })
    await both.first().click()
    await h.waitQuiet(page)
    await h.check('f2.one-name-on-the-wire', 'B', async () => {
      const got = lastReq(seen)
      return (JSON.stringify(got.names) === JSON.stringify(['F Both'])) || JSON.stringify(got)
    })
    await h.check('f2.both-chips-selected-count-is-one', 'B', async () => {
      const marks = await both.evaluateAll((els) => els.map((el) => el.getAttribute('data-selected')))
      const count = ((await group.locator('[data-picker-count]').textContent()) || '').trim()
      return (JSON.stringify(marks) === '["true","true"]' && count === '1 selected') || JSON.stringify({ marks, count })
    })
    await h.check('f2.active-filter-pill-once', 'B', async () => {
      const n = await page.getByRole('button', { name: 'Remove category filter F Both' }).count()
      return n === 1 || `pills ${n}`
    })
    await both.last().click()
    await h.waitQuiet(page)
    await h.check('f2.second-click-deselects', 'B', async () => {
      const got = { names: lastReq(seen).names, sel: await selectedIn(group) }
      return (got.names.length === 0 && got.sel.length === 0) || JSON.stringify(got)
    })
    const none = group.locator('[data-picker-leading="none"]')
    await none.click()
    await h.waitQuiet(page)
    await h.check('f2.no-category-leading-chip', 'B', async () => {
      const got = { req: lastReq(seen).none, on: await none.getAttribute('data-selected'), all: await group.locator('[data-picker-leading="all"]').isDisabled() }
      return (got.req === 'true' && got.on === 'true' && got.all === false) || JSON.stringify(got)
    })
    await group.locator('[data-picker-leading="all"]').click()
    await h.waitQuiet(page)
    await h.check('f2.all-categories-clears-both', 'B', async () => {
      const got = { req: lastReq(seen), none: await none.getAttribute('data-selected') }
      return (got.req.none === null && got.req.names.length === 0 && got.none === null) || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f2', native)
    await ctx.close()
  }
}

// (f3) A selected filter is never hidden: a non-recent account stays first in the collapsed row.
async function scenarioF3(browser) {
  console.log('\n=== (f3) A non-recent account, selected then collapsed, is still in the quick row')
  const { ctx, page, native } = await openFilters(browser)
  try {
    const group = filterGroup(page, 'filter_accounts')
    const target = 'F Car Loan'
    await h.check('f3.not-in-quick-row-at-first', 'B', async () => {
      const n = await chipOf(group, target).count()
      return n === 0 || `chip present: ${n}`
    })
    await pick(group, target)
    await h.waitQuiet(page)
    await toggleOf(group).click()
    await h.check('f3.collapsed-shows-it-first-and-selected', 'B', async () => {
      const ids = await idsIn(group)
      const got = { mode: await group.getAttribute('data-picker'), first: ids[0], sel: await selectedIn(group), count: ((await group.locator('[data-picker-count]').textContent()) || '').trim() }
      return (got.mode === 'collapsed' && got.first === String(filt.acct[target].id) && sameSet(got.sel, [got.first]) && got.count === '1 selected') || JSON.stringify(got)
    })
    await h.check('f3.recents-are-read-only', 'B', async () => {
      const got = await page.evaluate((key) => localStorage.getItem(key), `tt:recent:${filt.id}:account`)
      return got === null || `the filter wrote recents: ${JSON.stringify(got)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f3', native)
    await ctx.close()
  }
}

// (f4) Reset filters clears both pickers and the Active filters pills.
async function scenarioF4(browser) {
  console.log('\n=== (f4) Reset filters clears the account and category pickers')
  const { ctx, page, native, seen } = await openFilters(browser)
  try {
    const accounts = filterGroup(page, 'filter_accounts')
    const cats = filterGroup(page, 'filter_categories')
    await pick(accounts, 'F Wise USD')
    await h.waitQuiet(page)
    await pick(cats, 'F Both')
    await h.waitQuiet(page)
    await cats.locator('[data-picker-leading="none"]').click()
    await h.waitQuiet(page)
    await h.check('f4.filters-active-first', 'B', async () => {
      const got = lastReq(seen)
      const pills = await page.locator('[aria-label="Active filters"] button').count()
      return (got.accounts.length === 1 && got.names.length === 1 && got.none === 'true' && pills >= 2) || JSON.stringify({ got, pills })
    })
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await h.waitQuiet(page)
    await h.check('f4.reset-clears-both-pickers', 'B', async () => {
      const got = {
        req: lastReq(seen),
        accountsSel: await selectedIn(accounts),
        catsSel: await selectedIn(cats),
        allAcc: await accounts.locator('[data-picker-leading="all"]').getAttribute('data-selected'),
        allCat: await cats.locator('[data-picker-leading="all"]').getAttribute('data-selected'),
        none: await cats.locator('[data-picker-leading="none"]').getAttribute('data-selected'),
        pills: await page.locator('[aria-label="Active filters"]').count(),
      }
      const ok = got.req.accounts.length === 0 && got.req.names.length === 0 && got.req.none === null && got.accountsSel.length === 0 && got.catsSel.length === 0 && got.allAcc === 'true' && got.allCat === 'true' && got.none === null && got.pills === 0
      return ok || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f4', native)
    await ctx.close()
  }
}

// (f5) The 50-name cap and its message still apply.
async function scenarioF5(browser) {
  console.log('\n=== (f5) Categories filter: at most 50 names, with the message')
  const { ctx, page, native } = await openTransactions(browser, cap.user)
  const seen = listRequests(page)
  try {
    await filtersTab(page)
    const group = filterGroup(page, 'filter_categories')
    await toggleOf(group).click()
    const ids = (await idsIn(group)).filter((id) => id.startsWith('C Cap '))
    await h.check('f5.fifty-two-offered', 'S', async () => ids.length === 52 || `chips ${ids.length}`)
    for (const id of ids.slice(0, 51)) await group.locator(`[data-picker-id="${id}"]`).first().click()
    await h.waitQuiet(page)
    await h.check('f5.capped-at-50', 'B', async () => {
      const sel = await selectedIn(group)
      const msg = await page.getByText('You can filter by up to 50 categories at once.').count()
      return (sel.length === 50 && !sel.includes(ids[50]) && msg === 1 && lastReq(seen).names.length === 50) || JSON.stringify({ sel: sel.length, msg, sent: lastReq(seen).names.length })
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'f5', native)
    await ctx.close()
  }
}

// (g2) Accounts to aggregate: the caller's own accounts, grouped, the picked ids sent as account_ids.
async function scenarioG2(browser) {
  console.log('\n=== (g2) Accounts to aggregate: own accounts grouped by type; the picked account_ids are sent')
  const { ctx, page, native, creates, form } = await openAllocationForm(browser, 'Savings', savingsForm)
  try {
    await form.getByRole('button', { name: 'Combined account total' }).click()
    const group = control(form, 'savings_account_ids')
    await group.waitFor()
    await h.check('g2.own-accounts-only', 'B', async () => {
      const got = { mode: await group.getAttribute('data-picker'), toggle: await toggleOf(group).textContent() }
      return (got.mode === 'collapsed' && /^All 15 accounts/.test(got.toggle)) || JSON.stringify(got)
    })
    await pick(group, 'P Wise USD')
    await pick(group, 'P Cash')
    await h.check('g2.headings', 'B', async () => {
      const got = await headingsOf(group)
      return JSON.stringify(got) === JSON.stringify(['Debit', 'Credit', 'E-wallet', 'Cash', 'Loan']) || `headings ${JSON.stringify(got)}`
    })
    await field(form, 'account_id').selectOption(String(acct['P Bdo Savings'].id))
    await field(form, 'name').fill('Picker G2 tracker')
    await field(form, 'target_amount').fill('5000')
    await form.getByRole('button', { name: 'Create Savings Tracker' }).click()
    await page.getByLabel('Close allocation modal').waitFor({ state: 'detached', timeout: 6000 }).catch(() => null)
    await h.check('g2.post-body-account-ids', 'B', async () => {
      const ids = creates.length === 1 ? (creates[0]?.configuration?.account_ids ?? null) : null
      const want = [acct['P Wise USD'].id, acct['P Cash'].id].sort((a, b) => a - b)
      return (Array.isArray(ids) && JSON.stringify([...ids].sort((a, b) => a - b)) === JSON.stringify(want)) || `posts ${creates.length}, body ${JSON.stringify(creates[0])}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'g2', native)
    await ctx.close()
  }
}

// (g3) A refused save with the picker open focuses a chip, never the picker's toggle.
async function scenarioG3(browser) {
  console.log('\n=== (g3) Error focus with the picker open lands on a chip, not the toggle')
  const { ctx, page, native, creates, form } = await openAllocationForm(browser, 'Budgets', budgetForm)
  try {
    await field(form, 'account_id').selectOption(String(acct['P Bdo Savings'].id))
    await field(form, 'name').fill('Picker G3 envelope')
    await field(form, 'target_amount').fill('1000')
    const group = control(form, 'category_ids')
    await toggleOf(group).click()
    await form.getByRole('button', { name: 'Create Budget Envelope' }).click()
    const err = page.locator('[data-testid="field-error-category_ids"]')
    await err.waitFor({ timeout: 3000 }).catch(() => null)
    await h.check('g3.error-shown', 'B', async () => (await err.count()) === 1 || 'no category error')
    await h.check('g3.group-and-chips-described', 'B', async () => {
      const got = await group.evaluate((el) => ({
        role: el.getAttribute('role'),
        described: el.getAttribute('aria-describedby'),
        chips: [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-describedby')),
      }))
      return (got.role === 'group' && got.described === 'allocation-category_ids-error' &&
        got.chips.length > 0 && got.chips.every((c) => c === got.described)) || JSON.stringify(got)
    })
    await h.check('g3.focus-on-a-chip', 'B', async () => {
      const got = await page.evaluate(() => {
        const el = document.activeElement
        return { toggle: el?.hasAttribute('data-picker-toggle') ?? null, chip: el?.hasAttribute('data-picker-id') ?? null }
      })
      return (got.chip === true && got.toggle === false) || `active ${JSON.stringify(got)}`
    })
    await h.check('g3.nothing-sent', 'B', async () => creates.length === 0 || `${creates.length} POST /allocations`)
    // With a category already chosen, the failing field is elsewhere; a selected chip is what a group error would focus.
    await pick(group, 'Utilities')
    await h.check('g3.error-clears-on-pick', 'B', async () => (await err.count()) === 0 || 'the error stayed after a pick')
  } finally {
    await d.checkNoNativeDialogs(h, 'g3', native)
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'pickers')
  partner = await h.makeUser(stack, 'pickpart')
  ownerId = (await client.get(owner.token, '/auth/me')).id
  for (const [name, type, currency] of OWN) acct[name] = await client.post(owner.token, '/accounts/', accountBody(name, type, currency))
  for (const [name, type] of SHARED) {
    acct[name] = await client.post(partner.token, '/accounts/', accountBody(name, type))
    await client.post(partner.token, `/accounts/${acct[name].id}/shares`, { email: owner.email, role: 'editor' })
  }
  const list = await client.get(owner.token, '/accounts/?is_active=true&limit=100')
  const items = Array.isArray(list) ? list : list.items
  const writable = items.filter((a) => a.permissions && a.permissions.can_add_transactions)
  if (writable.length !== 17) throw new Error(`owner has ${writable.length} writable accounts, want 17`)
  const expense = (await client.get(owner.token, '/categories/')).filter((c) => c.kind === 'expense' && c.is_active !== false)
  if (expense.length !== 15) throw new Error(`owner has ${expense.length} expense categories, want 15`)
  const smallUser = await h.makeUser(stack, 'picksmall')
  for (let i = 1; i <= 8; i++) await client.post(smallUser.token, '/accounts/', accountBody(`S Account ${i}`, i % 2 ? 'checking' : 'cash'))
  small = { user: smallUser }
  // The filters' user: 10 accounts (collapsed), and a name used as both an expense and an income category.
  const filterUser = await h.makeUser(stack, 'pickfilt')
  const facct = {}
  for (const [name, type, currency] of [
    ['F Bdo Savings', 'savings'], ['F Bpi Checking', 'checking'], ['F Wise USD', 'savings', 'USD'], ['F Bpi Visa', 'credit'],
    ['F GCash', 'e_wallet'], ['F Maya', 'e_wallet'], ['F Cash', 'cash'], ['F Petty Cash', 'cash'], ['F Car Loan', 'loan'], ['F Home Loan', 'loan'],
  ]) facct[name] = await client.post(filterUser.token, '/accounts/', accountBody(name, type, currency))
  await client.post(filterUser.token, '/categories/', { name: 'F Both', color: '#16a34a', is_expense: true, kind: 'expense' })
  await client.post(filterUser.token, '/categories/', { name: 'F Both', color: '#16a34a', is_expense: false, kind: 'income' })
  const capUser = await h.makeUser(stack, 'pickcap')
  await client.post(capUser.token, '/accounts/', accountBody('C Cap Account', 'cash'))
  for (let i = 1; i <= 52; i++) await client.post(capUser.token, '/categories/', { name: `C Cap ${String(i).padStart(2, '0')}`, color: '#16a34a', is_expense: true, kind: 'expense' })
  cap = { user: capUser }
  filt = { user: filterUser, acct: facct, id: (await client.get(filterUser.token, '/auth/me')).id }
}

const SCENARIOS = [
  ['3', scenario3],
  ['4', scenario4],
  ['5', scenario5],
  ['6', scenario6],
  ['7', scenario7],
  ['8', scenario8],
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['f1', scenarioF1],
  ['f2', scenarioF2],
  ['f3', scenarioF3],
  ['f4', scenarioF4],
  ['f5', scenarioF5],
  ['g1', scenarioG1],
  ['g2', scenarioG2],
  ['g3', scenarioG3],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  try {
    await setup()
  } catch (e) {
    console.error('SETUP FAILED', e)
    stack.stop()
    process.exit(2)
  }
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
