// Browser checks for the compact pickers in the Add Transaction dialog (STU-580): an
// Account, Destination Account or Category with a value is one line (the choice and a
// Change button); without a value the field is its open panel. Change opens a panel under
// the line: a search box, any leading option ("Uncategorized"), a Recent group, then the
// grouped list, every option a full-width row. A pick, Escape or a click outside closes
// it. Other pickers (the transaction filters) are unchanged.
//
// (1) a field with a value is one line of at most 56 px: its text, no row, no panel;
// (4) a field with no value starts open, Escape there only clears the search and a click
// outside leaves it open, and an empty required account shows its error, described by it,
// with focus in the account search box; (2) Change opens an inline panel under the line,
// focus in its search box: leading rows, Recent first, then the groups, every row full
// width and stacked, a check mark on the current value, a max height that scrolls
// vertically, and nothing scrolls sideways at 390 px; (3) a pick sets the value, closes
// the panel and returns focus to Change without reopening, Escape clears the search then
// closes, and a click outside closes, both changing nothing; (5) searching hides Recent
// and filters the groups, Enter on one match picks it and never submits; (k) the keyboard
// path: Enter on Change, ArrowDown into the rows, ArrowUp back to the search box; (6) at
// 390 px the line and every row are at least 44 px and nothing scrolls sideways; (7) the
// transaction filters have no Change button and no rows; (8) the form is shorter with the
// fields collapsed than with either open, by at least a row; (9) a short list
// (transfer categories) shows rows with no Recent group. Every scenario checks that no
// browser dialog fired. Waits are on conditions, never fixed sleeps.
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
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }

let stack, client, user
/** Nine accounts (more than the flat limit of 8, so the panel has a Recent group), one with a long name. */
const LONG = 'Cpk Very Long Account Name That Cannot Possibly Fit On One Line Of A Phone Screen'
const NAMES = ['Cpk Alpha Savings Account', 'Cpk Bravo Checking Account', 'Cpk Charlie Cash Wallet', 'Cpk Delta Checking Account', 'Cpk Echo Savings Account', 'Cpk Foxtrot Cash Wallet', 'Cpk Golf Savings Account', 'Cpk Hotel Checking Account']

const formModal = (page) => page.locator('div.fixed').filter({ has: page.getByRole('heading', { name: 'Create Transaction', exact: true }) })
const control = (modal, key) => modal.locator(`[data-field="${key}"]`)
const changeOf = (group) => group.locator('[data-picker-change]')
const panelOf = (group) => group.locator('[data-picker-panel]')
const searchOf = (group) => group.locator('input[data-picker-search]')
const rowsOf = (group) => group.locator('[data-picker-list] button[data-picker-option]')
const isFocused = (locator) => locator.evaluate((el) => el === document.activeElement).catch(() => false)
const activeText = (page) => page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.tagName || '').trim())
const boxHeight = async (locator) => (await locator.boundingBox()).height
const lineText = async (group) => (await group.innerText()).replace(/\s+/g, ' ').trim()
const headingsIn = (group) => group.locator('[data-picker-heading]').evaluateAll((els) => els.map((el) => el.getAttribute('data-picker-heading')))

/** Waits (bounded) until `locator` holds the focus. */
async function waitFocus(page, locator, timeout = 5000) {
  const el = await locator.elementHandle()
  await page.waitForFunction((target) => document.activeElement === target, el, { timeout }).catch(() => {})
}
/** Waits (bounded) until the field is its collapsed line with focus on Change. */
async function waitClosed(page, group) {
  await group.locator('[data-picker-change][aria-expanded="false"]').waitFor({ timeout: 5000 }).catch(() => {})
  await waitFocus(page, changeOf(group))
}
/** Opens a collapsed field with Change and waits for focus in its search box. */
async function openField(page, group) {
  await changeOf(group).click()
  await searchOf(group).waitFor()
  await waitFocus(page, searchOf(group))
}

/** Everything inside the dialog (and the page) that scrolls sideways. */
const sidewaysScrollers = (page) => page.evaluate(() => {
  const out = []
  const doc = document.scrollingElement
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`document ${doc.scrollWidth}>${doc.clientWidth}`)
  for (const el of document.querySelectorAll('div.fixed, div.fixed *')) {
    if (['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName}.${el.className} ${el.scrollWidth}>${el.clientWidth}`)
  }
  return out
})

async function openAddForm(browser, contextOptions = {}) {
  const { ctx, page } = await h.newPage(browser, contextOptions)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const posts = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.replace(/\/$/, '').endsWith('/transactions')) posts.push(r.url())
  })
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/transactions`)
  await page.getByRole('button', { name: 'Add Transaction' }).first().waitFor()
  await h.waitQuiet(page)
  await page.getByRole('button', { name: 'Add Transaction' }).first().click()
  const modal = formModal(page)
  await modal.waitFor()
  await h.waitQuiet(page)
  await control(modal, 'account_id').locator('button').first().waitFor()
  return { ctx, page, native, modal, posts }
}

/** Chooses an account and a category, both by pick, leaving both fields collapsed. */
async function chooseBoth(page, modal) {
  await pick(control(modal, 'account_id'), NAMES[0])
  await waitClosed(page, control(modal, 'account_id'))
  await pick(control(modal, 'category_id'), /^Groceries/)
  await waitClosed(page, control(modal, 'category_id'))
}

// (1) and (4): collapsed lines; a field with no value is its open panel.
async function scenario1(browser) {
  console.log('\n=== (1)(4) a field with a value is one line; one without is its open panel')
  const { ctx, page, native, modal, posts } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    await h.check('4.account-starts-open', 'B', async () =>
      ((await changeOf(acct).count()) === 0 && (await panelOf(acct).count()) === 1 && (await rowsOf(acct).count()) > 0) || 'account field is not open')
    await h.check('1.category-starts-as-line', 'B', async () => {
      const text = await lineText(cat)
      return (text === 'Uncategorized Change' && (await cat.locator('[data-picker-id]').count()) === 0) || `text ${JSON.stringify(text)}`
    })
    // No value: Escape only clears the search, and a click outside leaves the panel open.
    await searchOf(acct).fill('Alpha')
    await searchOf(acct).focus()
    await page.keyboard.press('Escape')
    await h.check('4.no-value-escape-clears-search-only', 'B', async () => {
      const got = { query: await searchOf(acct).inputValue(), panel: await panelOf(acct).count(), modal: await modal.count(), focus: await isFocused(searchOf(acct)) }
      return (got.query === '' && got.panel === 1 && got.modal === 1 && got.focus) || JSON.stringify(got)
    })
    await page.keyboard.press('Escape')
    await h.check('4.no-value-second-escape-keeps-panel', 'B', async () =>
      ((await panelOf(acct).count()) === 1 && (await modal.count()) === 1) || `panel ${await panelOf(acct).count()}, modal ${await modal.count()}`)
    await control(modal, 'description').click()
    await h.check('4.no-value-outside-click-stays-open', 'B', async () =>
      ((await panelOf(acct).count()) === 1 && (await rowsOf(acct).count()) > 0) || 'the panel closed')
    // AC10: an empty required account.
    await control(modal, 'description').fill('Compact required')
    await control(modal, 'amount').fill('12')
    await modal.getByRole('button', { name: 'Create Transaction', exact: true }).click()
    const error = modal.locator('[data-testid="field-error-account_id"]')
    await error.waitFor({ timeout: 5000 })
    await waitFocus(page, searchOf(acct))
    await h.check('4.required-account-error-shown', 'B', async () =>
      ((await error.textContent()) || '').trim() === 'Please select an account for this transaction.' || `error ${JSON.stringify(await error.textContent())}`)
    await h.check('4.required-account-error-described', 'B', async () => {
      const id = await error.getAttribute('id')
      const got = { group: await acct.getAttribute('aria-describedby'), search: await searchOf(acct).getAttribute('aria-describedby') }
      return (!!id && got.group === id && got.search === id) || `error ${id}, ${JSON.stringify(got)}`
    })
    await h.check('4.required-account-focus-in-search', 'B', async () => (await isFocused(searchOf(acct))) || `active ${await activeText(page)}`)
    await h.check('4.required-account-no-post', 'B', async () => posts.length === 0 || `${posts.length} POST(s)`)
    await pick(acct, NAMES[1])
    await waitClosed(page, acct)
    await pick(cat, /^Groceries/)
    await waitClosed(page, cat)
    await h.check('1.account-line-text', 'B', async () => {
      const text = await lineText(acct)
      return text === `${NAMES[1]} (PHP) Change` || `text ${JSON.stringify(text)}`
    })
    await h.check('1.category-line-text', 'B', async () => {
      const text = await lineText(cat)
      return text === 'Groceries Change' || `text ${JSON.stringify(text)}`
    })
    for (const [key, group] of [['account', acct], ['category', cat]]) {
      await h.check(`1.${key}-no-row-no-panel`, 'B', async () => {
        const n = [await group.locator('[data-picker-id]').count(), await group.locator('[data-picker-toggle]').count(), await group.locator('input[type="search"]').count(), await panelOf(group).count()]
        return n.every((x) => x === 0) || `rows, toggle, search, panel ${JSON.stringify(n)}`
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

// (2)(5): Change opens an inline panel of rows; accessibility.
async function scenario2(browser) {
  console.log('\n=== (2)(5) Change opens an inline panel: search, leading, Recent, groups, as rows')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    const acct = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    await chooseBoth(page, modal)
    const change = changeOf(acct)
    await h.check('5.change-is-button-named-after-field', 'B', async () => {
      const name = await change.evaluate((el) => el.tagName)
      const btn = acct.getByRole('button', { name: /^Change Account\b.*Cpk Alpha/ })
      return (name === 'BUTTON' && (await btn.count()) === 1) || `tag ${name}, named matches ${await btn.count()}`
    })
    await h.check('5.collapsed-aria-expanded-false', 'B', async () => (await change.getAttribute('aria-expanded')) === 'false' || 'not false')
    await openField(page, acct)
    await h.check('5.expanded-aria-expanded-true', 'B', async () => {
      const got = { expanded: await change.getAttribute('aria-expanded'), controls: await change.getAttribute('aria-controls'), panel: await panelOf(acct).getAttribute('id') }
      return (got.expanded === 'true' && !!got.panel && got.controls === got.panel) || JSON.stringify(got)
    })
    await h.check('2.focus-in-search-on-open', 'B', async () => (await isFocused(searchOf(acct))) || `active ${await activeText(page)}`)
    await h.check('2.panel-inline-under-line', 'B', async () => {
      const got = await acct.evaluate((el) => {
        const line = el.querySelector('[data-picker-line]').getBoundingClientRect()
        const panel = el.querySelector('[data-picker-panel]')
        const r = panel.getBoundingClientRect()
        return { position: getComputedStyle(panel).position, gap: Math.round(r.top - line.bottom), inRoot: el.contains(panel) }
      })
      return (got.position === 'static' && got.gap >= 0 && got.gap <= 16 && got.inRoot) || JSON.stringify(got)
    })
    await h.check('2.search-first-then-recent', 'B', async () => {
      const got = await acct.evaluate((el) => {
        const panel = el.querySelector('[data-picker-panel]')
        const search = panel.querySelector('[data-picker-search]')
        const first = panel.querySelector('[data-picker-option]')
        return { searchFirst: !!(search.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING), firstGroup: first.closest('[data-picker-group]')?.getAttribute('data-picker-group') ?? null }
      })
      const headings = await headingsIn(acct)
      return (got.searchFirst && got.firstGroup === 'recent' && headings[0] === 'recent' && headings.length > 1) || JSON.stringify({ ...got, headings })
    })
    await h.check('2.recent-heading-and-max-5', 'B', async () => {
      const got = { heading: ((await acct.locator('[data-picker-heading="recent"]').textContent()) || '').trim(), n: await acct.locator('[data-picker-group="recent"] [data-picker-id]').count() }
      return (got.heading === 'Recent' && got.n >= 1 && got.n <= 5) || JSON.stringify(got)
    })
    await h.check('2.recent-holds-the-current-value', 'B', async () =>
      ((await acct.locator('[data-picker-group="recent"] [data-picker-id][data-selected="true"]').count()) === 1) || 'the chosen account is not in Recent')
    await h.check('2.rows-full-width-and-stacked', 'B', async () => {
      const got = await acct.locator('[data-picker-list]').evaluate((list) => {
        const rows = [...list.querySelectorAll('button[data-picker-option]')]
        const inner = list.clientWidth
        const narrow = rows.filter((b) => {
          const groupBox = b.parentElement.getBoundingClientRect()
          return Math.abs(b.getBoundingClientRect().width - groupBox.width) > 1 || b.getBoundingClientRect().width < inner * 0.8
        }).map((b) => b.textContent.trim())
        const tops = rows.map((b) => Math.round(b.getBoundingClientRect().top))
        const chips = rows.filter((b) => b.className.includes('rounded-full')).length
        return { n: rows.length, narrow, distinctTops: new Set(tops).size, chips }
      })
      return (got.n >= 9 && got.narrow.length === 0 && got.distinctTops === got.n && got.chips === 0) || JSON.stringify(got)
    })
    await h.check('2.check-mark-on-current-value-only', 'B', async () => {
      const got = await acct.evaluate((el) => {
        const rows = [...el.querySelectorAll('[data-picker-option]')]
        return {
          selectedWithMark: rows.filter((b) => b.dataset.selected === 'true' && b.querySelector('[data-picker-check]')?.textContent === '✓').length,
          selected: rows.filter((b) => b.dataset.selected === 'true').length,
          markOnOthers: rows.filter((b) => b.dataset.selected !== 'true' && b.querySelector('[data-picker-check]')).length,
        }
      })
      return (got.selected >= 1 && got.selectedWithMark === got.selected && got.markOnOthers === 0) || JSON.stringify(got)
    })
    await h.check('2.list-max-height-scrolls-vertically', 'B', async () => {
      const m = await acct.locator('[data-picker-list]').evaluate((el) => ({ max: getComputedStyle(el).maxHeight, oy: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight }))
      return (m.max !== 'none' && ['auto', 'scroll'].includes(m.oy) && m.sh > m.ch) || JSON.stringify(m)
    })
    await h.check('2.long-name-wraps-in-panel', 'B', async () => {
      const got = await acct.evaluate((el, long) => {
        const row = [...el.querySelectorAll('[data-picker-option]')].find((b) => b.textContent.startsWith(long))
        const list = el.querySelector('[data-picker-list]')
        if (!row) return { missing: true }
        const r = row.getBoundingClientRect()
        const l = list.getBoundingClientRect()
        return { h: Math.round(r.height), inside: r.left >= l.left - 0.5 && r.right <= l.right + 0.5, title: row.getAttribute('title') }
      }, LONG)
      return (got.h > 44 && got.inside && got.title.startsWith(LONG)) || JSON.stringify(got)
    })
    await h.check('2.no-sideways-scroll-at-390', 'B', async () => {
      const m = await acct.evaluate((el) => {
        const panel = el.querySelector('[data-picker-panel]')
        const list = el.querySelector('[data-picker-list]')
        let scroller = el.parentElement
        while (scroller && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
        return { panel: [panel.scrollWidth, panel.clientWidth], list: [list.scrollWidth, list.clientWidth], dialog: scroller ? [scroller.scrollWidth, scroller.clientWidth] : null }
      })
      const same = (pair) => pair !== null && pair[0] === pair[1]
      const wide = await sidewaysScrollers(page)
      return (same(m.panel) && same(m.list) && same(m.dialog) && wide.length === 0) || JSON.stringify({ ...m, wide })
    })
    // The category panel: the leading "Uncategorized" row first, then Recent.
    await change.click()
    await waitClosed(page, acct)
    await openField(page, cat)
    await h.check('2.category-leading-row-then-recent', 'B', async () => {
      const got = await cat.evaluate((el) => {
        const rows = [...el.querySelectorAll('[data-picker-list] [data-picker-option]')]
        return { first: rows[0]?.getAttribute('data-picker-leading') ?? null, second: rows[1]?.closest('[data-picker-group]')?.getAttribute('data-picker-group') ?? null }
      })
      return (got.first === 'none' && got.second === 'recent') || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, '2', native)
    await ctx.close()
  }
}

// (3): a pick, Escape and a click outside close the panel; focus on Change does not reopen.
async function scenario3(browser) {
  console.log('\n=== (3) a pick, Escape or a click outside closes; focus on Change does not reopen')
  const { ctx, page, native, modal } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    const change = changeOf(acct)
    await pick(acct, NAMES[0])
    await waitClosed(page, acct)
    await h.check('3.row-pick-closed-with-value', 'B', async () => {
      const text = await lineText(acct)
      return (text === `${NAMES[0]} (PHP) Change` && (await change.getAttribute('aria-expanded')) === 'false') || `text ${JSON.stringify(text)}`
    })
    await h.check('3.focus-on-change-after-pick', 'B', async () => (await isFocused(change)) || `active ${await activeText(page)}`)
    await h.check('3.focus-did-not-expand', 'B', async () =>
      ((await change.getAttribute('aria-expanded')) === 'false' && (await acct.locator('[data-picker-id]').count()) === 0 && (await acct.getAttribute('data-picker')) === 'line') || 'field reopened')
    // Escape changes nothing.
    await openField(page, acct)
    await page.keyboard.press('Escape')
    await waitClosed(page, acct)
    await h.check('3.escape-closes-keeps-value', 'B', async () => {
      const text = await lineText(acct)
      return (text === `${NAMES[0]} (PHP) Change` && (await change.getAttribute('aria-expanded')) === 'false' && (await modal.count()) === 1) || `text ${JSON.stringify(text)}, modal ${await modal.count()}`
    })
    await h.check('3.escape-focus-on-change-stays-closed', 'B', async () =>
      ((await isFocused(change)) && (await change.getAttribute('aria-expanded')) === 'false' && (await panelOf(acct).count()) === 0) || `active ${await activeText(page)}`)
    // A click outside the field closes it and changes nothing.
    await openField(page, acct)
    await modal.getByRole('heading', { name: 'Create Transaction', exact: true }).click()
    await acct.locator('[data-picker-change][aria-expanded="false"]').waitFor({ timeout: 5000 }).catch(() => {})
    await h.check('3.outside-click-closes-keeps-value', 'B', async () => {
      const got = { text: await lineText(acct), panel: await panelOf(acct).count(), modal: await modal.count() }
      return (got.text === `${NAMES[0]} (PHP) Change` && got.panel === 0 && got.modal === 1) || JSON.stringify(got)
    })
    // A pick from the grouped list (a category found by search).
    const cat = control(modal, 'category_id')
    await openField(page, cat)
    const search = searchOf(cat)
    await search.fill('Transport')
    const option = cat.locator('[data-picker-group] [data-picker-id]').first()
    const optionName = (await option.innerText()).trim()
    await option.click()
    await waitClosed(page, cat)
    await h.check('3.list-pick-sets-value-and-closes', 'B', async () => {
      const text = await lineText(cat)
      return (text === `${optionName} Change` && (await cat.locator('input[type="search"]').count()) === 0) || `text ${JSON.stringify(text)}`
    })
    await h.check('3.list-pick-focus-on-change', 'B', async () => (await isFocused(changeOf(cat))) || `active ${await activeText(page)}`)
    // Escape from the search box: the first clears the query, the next closes the field.
    await openField(page, cat)
    await search.fill('Trans')
    await page.keyboard.press('Escape')
    await h.check('3.search-escape-clears-query-only', 'B', async () =>
      ((await search.inputValue()) === '' && (await changeOf(cat).getAttribute('aria-expanded')) === 'true' && (await isFocused(search))) || `query ${JSON.stringify(await search.inputValue())}, expanded ${await changeOf(cat).getAttribute('aria-expanded')}`)
    await page.keyboard.press('Escape')
    await waitClosed(page, cat)
    await h.check('3.search-escape-empty-closes-field', 'B', async () => {
      const got = { expanded: await changeOf(cat).getAttribute('aria-expanded'), search: await cat.locator('input[type="search"]').count(), focus: await isFocused(changeOf(cat)), modal: await modal.count(), text: await lineText(cat) }
      return (got.expanded === 'false' && got.search === 0 && got.focus && got.modal === 1 && got.text === `${optionName} Change`) || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, '3', native)
    await ctx.close()
  }
}

// (5): search hides Recent and filters the groups; Enter picks one match and never submits.
async function scenario5(browser) {
  console.log('\n=== (5) search hides Recent and filters; Enter picks the one match, never submits')
  const { ctx, page, native, modal, posts } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    await chooseBoth(page, modal)
    await openField(page, acct)
    const search = searchOf(acct)
    await search.fill('Checking')
    await h.check('5.search-hides-recent', 'B', async () => {
      const got = { recent: await acct.locator('[data-picker-group="recent"]').count(), headings: await headingsIn(acct) }
      return (got.recent === 0 && !got.headings.includes('recent')) || JSON.stringify(got)
    })
    await h.check('5.search-filters-groups-no-duplicates', 'B', async () => {
      const names = await acct.locator('[data-picker-id]').evaluateAll((els) => els.map((el) => el.childNodes[0].textContent.trim()))
      const want = NAMES.filter((n) => n.includes('Checking')).sort()
      return (JSON.stringify([...names].sort()) === JSON.stringify(want) && new Set(names).size === names.length) || `rows ${JSON.stringify(names)}`
    })
    await page.keyboard.press('Enter')
    await h.check('5.enter-many-picks-nothing', 'B', async () =>
      ((await changeOf(acct).getAttribute('aria-expanded')) === 'true' && posts.length === 0 && (await modal.count()) === 1) || `expanded ${await changeOf(acct).getAttribute('aria-expanded')}, ${posts.length} POST(s)`)
    await search.fill('Delta')
    await page.keyboard.press('Enter')
    await waitClosed(page, acct)
    await h.check('5.enter-one-match-picks', 'B', async () => {
      const text = await lineText(acct)
      return text === `${NAMES[3]} (PHP) Change` || `text ${JSON.stringify(text)}`
    })
    await h.check('5.enter-never-submits', 'B', async () => (posts.length === 0 && (await modal.count()) === 1) || `${posts.length} POST(s)`)
  } finally {
    await d.checkNoNativeDialogs(h, '5', native)
    await ctx.close()
  }
}

// (k): the keyboard path.
async function scenarioK(browser) {
  console.log('\n=== (k) keyboard: Enter on Change, ArrowDown into the rows, ArrowUp back to search')
  const { ctx, page, native, modal } = await openAddForm(browser)
  try {
    const acct = control(modal, 'account_id')
    await chooseBoth(page, modal)
    await changeOf(acct).focus()
    await page.keyboard.press('Enter')
    await searchOf(acct).waitFor()
    await waitFocus(page, searchOf(acct))
    await h.check('k.enter-on-change-opens-with-focus-in-search', 'B', async () =>
      ((await changeOf(acct).getAttribute('aria-expanded')) === 'true' && (await isFocused(searchOf(acct)))) || `active ${await activeText(page)}`)
    const rows = rowsOf(acct)
    await page.keyboard.press('ArrowDown')
    await h.check('k.arrow-down-from-search-to-first-row', 'B', async () => (await isFocused(rows.nth(0))) || `active ${await activeText(page)}`)
    await page.keyboard.press('ArrowDown')
    await h.check('k.arrow-down-to-second-row', 'B', async () => (await isFocused(rows.nth(1))) || `active ${await activeText(page)}`)
    await page.keyboard.press('ArrowUp')
    await h.check('k.arrow-up-to-first-row', 'B', async () => (await isFocused(rows.nth(0))) || `active ${await activeText(page)}`)
    await page.keyboard.press('ArrowUp')
    await h.check('k.arrow-up-from-first-row-to-search', 'B', async () => (await isFocused(searchOf(acct))) || `active ${await activeText(page)}`)
    await h.check('k.window-did-not-scroll-sideways', 'B', async () => (await page.evaluate(() => window.scrollX)) === 0 || 'window.scrollX moved')
    // Down to a row that is not the current value, and Enter picks it.
    await page.keyboard.press('ArrowDown')
    let target = ''
    for (let i = 0; i < 12; i++) {
      const got = await page.evaluate(() => ({ selected: document.activeElement?.getAttribute('data-selected'), name: document.activeElement?.childNodes[0]?.textContent?.trim() ?? '' }))
      if (got.selected !== 'true') { target = got.name; break }
      await page.keyboard.press('ArrowDown')
    }
    await h.check('k.reached-another-row', 'S', async () => target !== '' || 'no other row reached')
    await page.keyboard.press('Enter')
    await waitClosed(page, acct)
    await h.check('k.enter-on-row-picks-and-focuses-change', 'B', async () => {
      const text = await lineText(acct)
      return (text === `${target} (PHP) Change` && (await isFocused(changeOf(acct)))) || `text ${JSON.stringify(text)}, active ${await activeText(page)}`
    })
    await h.check('k.rows-keep-data-attributes', 'B', async () => {
      await openField(page, acct)
      const got = await acct.locator('[data-picker-list] [data-picker-id]').evaluateAll((els) => els.map((el) => ({ tag: el.tagName, sel: el.getAttribute('data-selected') })))
      return (got.length > 0 && got.every((x) => x.tag === 'BUTTON') && got.some((x) => x.sel === 'true')) || JSON.stringify(got.slice(0, 3))
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'k', native)
    await ctx.close()
  }
}

// (6): phone sizes.
async function scenario6(browser) {
  console.log('\n=== (6) 390 px: 44 px targets, and nothing scrolls sideways')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    await chooseBoth(page, modal)
    const small = () => modal.evaluate((el) => [...el.querySelectorAll('[data-field="account_id"] button, [data-field="category_id"] button')]
      .map((b) => ({ name: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) }))
      .filter((x) => x.h < 44 || x.w < 44))
    await h.check('6.collapsed-targets-44px', 'B', async () => {
      const s = await small()
      return s.length === 0 || JSON.stringify(s)
    })
    await h.check('6.collapsed-no-sideways-scroll', 'B', async () => {
      const w = await sidewaysScrollers(page)
      return w.length === 0 || JSON.stringify(w)
    })
    await h.check('6.long-name-stays-one-line', 'B', async () => {
      await pick(control(modal, 'account_id'), LONG)
      await waitClosed(page, control(modal, 'account_id'))
      const got = await control(modal, 'account_id').evaluate((el) => {
        const v = el.querySelector('[data-picker-value]')
        const cs = getComputedStyle(v)
        const doc = document.scrollingElement
        return { text: v.textContent, title: v.getAttribute('title'), lines: Math.round(v.getBoundingClientRect().height / parseFloat(cs.lineHeight)), truncated: v.scrollWidth > v.clientWidth, line: el.getBoundingClientRect().height, doc: doc.scrollWidth <= doc.clientWidth + 1 }
      })
      return (got.text.startsWith(LONG) && got.title.startsWith(LONG) && got.lines === 1 && got.truncated && got.line <= 56 && got.doc) || JSON.stringify(got)
    })
    await h.check('6.long-name-in-change-accessible-name', 'B', async () =>
      (await control(modal, 'account_id').getByRole('button', { name: new RegExp(`^Change Account .*${LONG}`) }).count()) === 1 || 'Change name lacks the full value')
    // One open at a time: opening the category (a press outside the account) closes the account.
    for (const key of ['account_id', 'category_id']) {
      await openField(page, control(modal, key))
      await h.check(`6.open-${key}-rows-44px`, 'B', async () => {
        const s = await small()
        const n = await control(modal, key).locator('[data-picker-option]').count()
        return (n > 0 && s.length === 0) || `${n} rows, small ${JSON.stringify(s)}`
      })
      await h.check(`6.open-${key}-nothing-scrolls-sideways`, 'B', async () => {
        const w = await sidewaysScrollers(page)
        return w.length === 0 || JSON.stringify(w)
      })
    }
    await h.check('6.opening-category-closed-account', 'B', async () =>
      ((await panelOf(control(modal, 'account_id')).count()) === 0 && (await changeOf(control(modal, 'account_id')).getAttribute('aria-expanded')) === 'false') || 'the account panel is still open')
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
    await h.check('7.filters-keep-chips-not-rows', 'B', async () => {
      const got = await page.locator('[data-field="filter_accounts"]').evaluate((el) => ({
        rows: el.querySelectorAll('[data-picker-option], [data-picker-panel], [data-picker-list]').length,
        chips: [...el.querySelectorAll('[data-picker-id]')].filter((b) => b.className.includes('rounded-full')).length,
        ids: el.querySelectorAll('[data-picker-id]').length,
      }))
      return (got.rows === 0 && got.ids > 0 && got.chips === got.ids) || JSON.stringify(got)
    })
  } finally {
    await d.checkNoNativeDialogs(h, '7', native)
    await ctx.close()
  }
}

// (8): the form is shorter collapsed than open, same run, same data.
async function scenario8(browser) {
  console.log('\n=== (8) the fields collapsed is shorter than either open')
  const { ctx, page, native, modal } = await openAddForm(browser, PHONE)
  try {
    await chooseBoth(page, modal)
    const acct = control(modal, 'account_id')
    const cat = control(modal, 'category_id')
    const formHeight = () => modal.locator('form').evaluate((el) => el.scrollHeight)
    const collapsed = await formHeight()
    // One field open at a time (a press on the other's Change is outside it), so each is measured alone.
    for (const [key, group] of [['account', acct], ['category', cat]]) {
      await openField(page, group)
      const open = await formHeight()
      const row = await rowsOf(group).first().evaluate((el) => el.getBoundingClientRect().height)
      console.log(`  form height collapsed ${collapsed}px, ${key} open ${open}px, row ${row}px`)
      await h.check(`8.collapsed-shorter-than-${key}-open-by-a-row`, 'B', async () =>
        open - collapsed >= row || `open ${open} - collapsed ${collapsed} < ${row}`)
      await page.keyboard.press('Escape')
      await waitClosed(page, group)
    }
    await h.check('8.back-to-collapsed-height', 'B', async () => {
      const now = await formHeight()
      return now === collapsed || `now ${now}, collapsed ${collapsed}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '8', native)
    await ctx.close()
  }
}

// (9): a short list shows rows with no Recent group.
async function scenario9(browser) {
  console.log('\n=== (9) a short list (transfer categories) shows rows, no Recent group')
  const { ctx, page, native, modal } = await openAddForm(browser)
  try {
    await modal.getByRole('button', { name: 'Transfer', exact: true }).click()
    const cat = control(modal, 'category_id')
    await changeOf(cat).waitFor()
    await openField(page, cat)
    await h.check('9.flat-rows-no-recent', 'B', async () => {
      const got = {
        mode: await cat.getAttribute('data-picker'),
        rows: await rowsOf(cat).count(),
        recent: await cat.locator('[data-picker-group="recent"]').count(),
        first: await rowsOf(cat).first().getAttribute('data-picker-leading'),
        search: await searchOf(cat).count(),
      }
      return (got.mode === 'flat' && got.rows >= 2 && got.recent === 0 && got.first === 'none' && got.search === 1) || JSON.stringify(got)
    })
    const second = rowsOf(cat).nth(1)
    const name = ((await second.textContent()) || '').trim()
    await second.click()
    await waitClosed(page, cat)
    await h.check('9.flat-row-picks', 'B', async () => {
      const text = await lineText(cat)
      return text === `${name} Change` || `text ${JSON.stringify(text)}, want ${name}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, '9', native)
    await ctx.close()
  }
}

async function setup() {
  user = await h.makeUser(stack, 'compactpick')
  for (const name of [...NAMES, LONG]) await client.post(user.token, '/accounts/', { name, account_type: 'checking', balance: 1000, currency: 'PHP' })
  const cats = (await client.get(user.token, '/categories/')).filter((c) => c.kind === 'expense' && c.is_active !== false)
  if (cats.length < 6) throw new Error(`user has ${cats.length} expense categories, want at least 6`)
  if (!cats.some((c) => c.name === 'Groceries')) throw new Error('no Groceries category')
}

const SCENARIOS = [['1', scenario1], ['2', scenario2], ['3', scenario3], ['5', scenario5], ['k', scenarioK], ['6', scenario6], ['7', scenario7], ['8', scenario8], ['9', scenario9]]

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
