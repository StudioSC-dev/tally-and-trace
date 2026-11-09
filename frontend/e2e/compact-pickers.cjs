// Browser checks for the compact pickers in the Add Transaction dialog (STU-580): an
// Account, Destination Account or Category with a value is one line (the choice and a
// Change button); without a value it starts open. Open, it is one sideways-scrolling chip
// row above the grouped, searchable list. A pick or Escape collapses it. Other pickers
// (the transaction filters) are unchanged.
//
// (1) a field with a value is one line of at most 56 px: its text, no chip, no list;
// (2) Change opens one non-wrapping row that overflows sideways, scrolling it leaves
// window.scrollX at 0; (3) a chip pick and a list pick set the value and collapse, Escape
// collapses and changes nothing, and focus returned to Change does not reopen the field;
// (4) a field with no value starts open and a required-field error still shows; (5) Change
// is a button named after the field, with aria-expanded, focus moves into the row and back;
// (6) at 390 px the line and every chip are at least 44 px and only the row scrolls
// sideways; (7) the transaction filters have no Change button; (8) with both fields
// collapsed the form is shorter than with both open by at least a chip row per field.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/compact-pickers.cjs [scenario]
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
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }

let stack, client, user
/** Seven accounts with long names, so a row of them is wider than a phone. */
const NAMES = ['Cpk Alpha Savings Account', 'Cpk Bravo Checking Account', 'Cpk Charlie Cash Wallet', 'Cpk Delta Checking Account', 'Cpk Echo Savings Account', 'Cpk Foxtrot Cash Wallet', 'Cpk Golf Savings Account']

const formModal = (page) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Create Transaction', exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const changeOf = (group) => group.locator('[data-picker-change]')
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement).catch(() => false)
const activeText = (page) => page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.tagName || '').trim())
const boxHeight = async (locator) => (await locator.boundingBox()).height

async function openAddForm(browser, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page)
  await modal.waitFor()
  await h.waitQuiet(page)
  await control(modal, 'account_id').locator('button').first().waitFor()
  return { ctx, page, native, modal }
}

/** Opens the field with both account and category chosen (account by pick, category by pick). */
async function chooseBoth(modal) {
  await pick(control(modal, 'account_id'), NAMES[0])
  await pick(control(modal, 'category_id'), /^Groceries/)
}

// (1) and (4): collapsed lines, and a field with no value starts open.
async function scenario1(browser) {
  console.log('\n=== (1)(4) a field with a value is one line; one without starts open')
  const { ctx, page, native, modal } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    await h.check('4.account-starts-open', 'B', async () =>
      ((await changeOf(acct).count()) === 0 && (await acct.locator('[data-picker-id]').count()) > 0) || 'account field is not open')
    await h.check('1.category-starts-as-line', 'B', async () => {
      const text = (await cat.innerText()).replace(/\s+/g, ' ').trim()
      return (text === 'Uncategorized Change' && (await cat.locator('[data-picker-id]').count()) === 0) || `text ${JSON.stringify(text)}`
    })
    await h.check('4.required-account-error', 'B', async () => {
      await control(modal, 'description').fill('Compact required')
      await control(modal, 'amount').fill('12')
      await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
      await modal.locator('[data-testid="field-error-account_id"]').waitFor({ timeout: 5000 })
      return true
    })
    await pick(acct, NAMES[1])
    await pick(cat, /^Groceries/)
    await h.check('1.account-line-text', 'B', async () => {
      const text = (await acct.innerText()).replace(/\s+/g, ' ').trim()
      return text === `${NAMES[1]} (PHP) Change` || `text ${JSON.stringify(text)}`
    })
    await h.check('1.category-line-text', 'B', async () => {
      const text = (await cat.innerText()).replace(/\s+/g, ' ').trim()
      return text === 'Groceries Change' || `text ${JSON.stringify(text)}`
    })
    for (const [key, group] of [['account', acct], ['category', cat]]) {
      await h.check(`1.${key}-no-chip-no-list`, 'B', async () => {
        const n = [await group.locator('[data-picker-id]').count(), await group.locator('[data-picker-toggle]').count(), await group.locator('input[type="search"]').count(), await group.locator('[data-picker-row]').count()]
        return n.every((x) => x === 0) || `chips, toggle, search, row ${JSON.stringify(n)}`
      })
      await h.check(`1.${key}-line-max-56px`, 'B', async () => {
        const hgt = await boxHeight(group)
        return hgt <= 56 || `${hgt}px`
      })
    }
  } finally {
    await d.checkNoNativeDialogs(h, '1', native)
    await ctx.close()
  }
}

// (2)(5): Change opens one scrolling row; accessibility.
async function scenario2(browser) {
  console.log('\n=== (2)(5) Change opens one sideways-scrolling row; names, aria-expanded and focus')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    const acct = control(modal, 'account_id')
    await pick(acct, NAMES[0])
    const change = changeOf(acct)
    await h.check('5.change-is-button-named-after-field', 'B', async () => {
      const name = await change.evaluate((el) => el.tagName)
      const btn = acct.getByRole('button', { name: /^Change Account\b.*Cpk Alpha/ })
      return (name === 'BUTTON' && (await btn.count()) === 1) || `tag ${name}, named matches ${await btn.count()}`
    })
    await h.check('5.collapsed-aria-expanded-false', 'B', async () => (await change.getAttribute('aria-expanded')) === 'false' || 'not false')
    await change.click()
    await h.check('5.expanded-aria-expanded-true', 'B', async () => (await change.getAttribute('aria-expanded')) === 'true' || 'not true')
    await h.check('5.focus-moves-into-row', 'B', async () =>
      (await acct.locator('[data-picker-row]').evaluate((row) => row.contains(document.activeElement))) || `active ${await activeText(page)}`)
    const row = acct.locator('[data-picker-row]')
    await h.check('2.chips-share-one-top', 'B', async () => {
      const tops = await row.locator('[data-picker-id]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
      return (tops.length >= 6 && new Set(tops).size === 1) || `tops ${JSON.stringify(tops)}`
    })
    await h.check('2.row-overflows-sideways', 'B', async () => {
      const m = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX, wrap: getComputedStyle(el).flexWrap }))
      return (m.sw > m.cw && ['auto', 'scroll'].includes(m.ox) && m.wrap === 'nowrap') || JSON.stringify(m)
    })
    await h.check('2.row-height-is-one-chip-row', 'B', async () => {
      const m = await row.evaluate((el) => ({ row: el.getBoundingClientRect().height, chip: el.querySelector('[data-picker-id]').getBoundingClientRect().height }))
      return m.row <= m.chip + 20 || JSON.stringify(m)
    })
    await h.check('2.scrolling-row-leaves-window-at-0', 'B', async () => {
      await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
      const m = await row.evaluate((el) => ({ left: el.scrollLeft, x: window.scrollX }))
      return (m.left > 0 && m.x === 0) || JSON.stringify(m)
    })
    await h.check('2.page-has-no-sideways-scroll', 'B', async () =>
      page.evaluate(() => { const e = document.scrollingElement; return e.scrollWidth <= e.clientWidth + 1 || `${e.scrollWidth}>${e.clientWidth}` }))
  } finally {
    await d.checkNoNativeDialogs(h, '2', native)
    await ctx.close()
  }
}

// (3): picks and Escape collapse; focus returned to Change does not reopen.
async function scenario3(browser) {
  console.log('\n=== (3) a pick or Escape collapses; focus on Change does not reopen')
  const { ctx, page, native, modal } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    const change = changeOf(acct)
    await pick(acct, NAMES[0])
    await h.check('3.chip-pick-collapsed-with-value', 'B', async () => {
      const text = (await acct.innerText()).replace(/\s+/g, ' ').trim()
      return (text === `${NAMES[0]} (PHP) Change` && (await change.getAttribute('aria-expanded')) === 'false') || `text ${JSON.stringify(text)}`
    })
    await h.check('3.focus-on-change-after-pick', 'B', async () => (await isFocused(change)) || `active ${await activeText(page)}`)
    await page.waitForTimeout(300)
    await h.check('3.focus-did-not-expand', 'B', async () =>
      ((await change.getAttribute('aria-expanded')) === 'false' && (await acct.locator('[data-picker-id]').count()) === 0) || 'field reopened')
    // Escape changes nothing.
    await change.click()
    await page.keyboard.press('Escape')
    await h.check('3.escape-collapses-keeps-value', 'B', async () => {
      const text = (await acct.innerText()).replace(/\s+/g, ' ').trim()
      return (text === `${NAMES[0]} (PHP) Change` && (await change.getAttribute('aria-expanded')) === 'false' && (await modal.count()) === 1) || `text ${JSON.stringify(text)}, modal ${await modal.count()}`
    })
    await h.check('3.escape-focus-on-change-stays-collapsed', 'B', async () => {
      await page.waitForTimeout(300)
      return ((await isFocused(change)) && (await change.getAttribute('aria-expanded')) === 'false') || `active ${await activeText(page)}`
    })
    // A pick from the grouped list (a category outside the quick row).
    const cat = control(modal, 'category_id')
    await changeOf(cat).click()
    await cat.locator('[data-picker-toggle]').click()
    const search = cat.locator('input[type="search"]')
    await search.fill('Transport')
    const option = cat.locator('[data-picker-group] [data-picker-id]').first()
    const optionName = (await option.innerText()).trim()
    await option.click()
    await h.check('3.list-pick-sets-value-and-collapses', 'B', async () => {
      const text = (await cat.innerText()).replace(/\s+/g, ' ').trim()
      return (text === `${optionName} Change` && (await cat.locator('input[type="search"]').count()) === 0) || `text ${JSON.stringify(text)}`
    })
    await h.check('3.list-pick-focus-on-change', 'B', async () => (await isFocused(changeOf(cat))) || `active ${await activeText(page)}`)
  } finally {
    await d.checkNoNativeDialogs(h, '3', native)
    await ctx.close()
  }
}

// (6): phone sizes.
async function scenario6(browser) {
  console.log('\n=== (6) 390 px: 44 px targets, and only the row scrolls sideways')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    await chooseBoth(modal)
    const small = () => modal.evaluate((el) => [...el.querySelectorAll('[data-field="account_id"] button, [data-field="category_id"] button')]
      .map((b) => ({ name: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) }))
      .filter((x) => x.h < 44 || x.w < 44))
    const wide = () => page.evaluate(() => {
      const out = []
      const doc = document.scrollingElement
      if (doc.scrollWidth > doc.clientWidth + 1) out.push(`document ${doc.scrollWidth}>${doc.clientWidth}`)
      for (const el of document.querySelectorAll('div.fixed, div.fixed *')) {
        if (el.hasAttribute('data-picker-row')) continue
        if (['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.closest('[data-picker-row]')) out.push(`${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`)
      }
      return out
    })
    await h.check('6.collapsed-targets-44px', 'B', async () => {
      const s = await small()
      return s.length === 0 || JSON.stringify(s)
    })
    await h.check('6.collapsed-no-sideways-scroll', 'B', async () => {
      const w = await wide()
      return w.length === 0 || JSON.stringify(w)
    })
    await changeOf(control(modal, 'account_id')).click()
    await changeOf(control(modal, 'category_id')).click()
    await h.check('6.open-chips-44px', 'B', async () => {
      const s = await small()
      const n = await modal.locator('[data-picker-id]').count()
      return (n > 0 && s.length === 0) || `${n} chips, small ${JSON.stringify(s)}`
    })
    await h.check('6.open-only-row-scrolls', 'B', async () => {
      const w = await wide()
      return w.length === 0 || JSON.stringify(w)
    })
  } finally {
    await d.checkNoNativeDialogs(h, '6', native)
    await ctx.close()
  }
}

// (7): other pickers are unchanged.
async function scenario7(browser) {
  console.log('\n=== (7) the transaction filters keep the old pickers')
  const { ctx, page, native } = await h.newPage(browser).then(async ({ ctx, page }) => {
    page.setDefaultTimeout(10000)
    const native = d.trackNativeDialogs(page)
    await h.uiLogin(page, stack, user)
    await page.goto(`${stack.webUrl}/transactions`)
    await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
    await h.waitQuiet(page)
    return { ctx, page, native }
  })
  try {
    await page.getByRole('button', { name: 'Show filters' }).click()
    await page.locator('[data-field="filter_accounts"]').waitFor()
    await h.check('7.filters-have-no-change-button', 'B', async () => {
      const n = await page.locator('[data-field="filter_accounts"] [data-picker-change], [data-field="filter_categories"] [data-picker-change]').count()
      const modes = await page.locator('[data-field="filter_accounts"], [data-field="filter_categories"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-picker')))
      return (n === 0 && modes.every((m) => m !== 'line')) || `change ${n}, modes ${JSON.stringify(modes)}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '7', native)
    await ctx.close()
  }
}

// (8): the form is shorter collapsed than open, same run, same data.
async function scenario8(browser) {
  console.log('\n=== (8) both fields collapsed is shorter than both open')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    await chooseBoth(modal)
    const acct = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    const formHeight = () => modal.locator('form').evaluate((el) => el.scrollHeight)
    const collapsed = await formHeight()
    await changeOf(acct).click()
    await changeOf(cat).click()
    const open = await formHeight()
    const chipRow = await acct.locator('[data-picker-row]').evaluate((el) => el.getBoundingClientRect().height)
    console.log(`  form height collapsed ${collapsed}px, open ${open}px, chip row ${chipRow}px`)
    await h.check('8.collapsed-shorter-by-two-chip-rows', 'B', async () =>
      open - collapsed >= 2 * chipRow || `open ${open} - collapsed ${collapsed} < 2 x ${chipRow}`)
  } finally {
    await d.checkNoNativeDialogs(h, '8', native)
    await ctx.close()
  }
}

async function setup() {
  user = await h.makeUser(stack, 'compactpick')
  for (const name of NAMES) await client.post(user.token, '/accounts/', { name, account_type: 'checking', balance: 1000, currency: 'PHP' })
  const cats = (await client.get(user.token, '/categories/')).filter((c) => c.kind === 'expense' && c.is_active !== false)
  if (cats.length < 6) throw new Error(`user has ${cats.length} expense categories, want at least 6`)
  if (!cats.some((c) => c.name === 'Groceries')) throw new Error('no Groceries category')
}

const SCENARIOS = [['1', scenario1], ['2', scenario2], ['3', scenario3], ['6', scenario6], ['7', scenario7], ['8', scenario8]]

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
