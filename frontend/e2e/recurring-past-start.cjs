// Browser checks for STU-630: a recurring entry's next occurrence before today. The Add and
// Edit recurring entry form warns, names the first date the schedule will use and offers
// "Use next year"; saving still works and keeps the date; the forecast and the Due card show
// the date the warning named.
//
// warning_names_first_used_date (AC1): a past date in Add (monthly, weekly, quarterly, annual)
//   and in Edit (monthly, and semi-monthly, which Add does not offer, on an entry seeded through
//   the API) shows the warning with the first date that will be used;
// move_to_next_year, move_older_date_to_next_year, move_leap_day_to_next_year (AC2): "Use next
//   year" sets the year to Manila's year plus one, keeping month, day and time (29 February
//   becomes 28 February when that year is not a leap year), inside the field's max, and the
//   warning goes away;
// no_warning_for_future (AC3): today's date and a later one show no warning;
// saved_past_date_matches_warning (AC4): saving a past date in each cadence works, and the
//   forecast's first occurrence of the entry is the date the warning named;
// due_card_matches_warning (AC4): the Due card's next date for the entry (its Upcoming tab) is
//   the date the warning named;
// save_preserves_selected_past_date (AC6): the saved next occurrence is the picked date
//   exactly, and Edit reopens it;
// existing_recurrence_results_unchanged (AC6): a future-dated entry shows no warning and its
//   forecast's first occurrence is its own date.
// Every scenario checks that no browser dialog fired.
//
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and seeds
// through the API. Not wired into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural, [G] guard. The script ends with RESULT: k/m
// and exits 0 only when every check passed, 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/recurring-past-start.cjs [scenario name]
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const d = require('./_dialogs.cjs')
const { useDueCheck, readTab } = require('./_due_pages.cjs')

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

useDueCheck((what, actual, expected) =>
  h.check(what, 'S', () => JSON.stringify(actual) === JSON.stringify(expected) || `actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const addDays = (value, n) => {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
/** "Dec 5th, 2026" (the app's formatEntryDate) back to `2026-12-05`. */
const dayOfLabel = (label) => {
  const m = /^([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4})$/.exec(label)
  if (!m) return null
  return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`
}
const NAMED = /^This date is in the past\. The first occurrence will be (.+)\.$/

const addForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Save Recurring Entry' }) })
const editForm = (page) => page.locator('form').filter({ has: page.getByRole('button', { name: 'Update Recurring Entry' }) })
const field = (form, key) => form.locator(`[data-field="${key}"]`)
const warning = (form) => form.locator('[data-testid="past-start-warning"]')
const nextYear = (form) => form.locator('[data-testid="past-start-next-year"]')

const account = (user, name) =>
  client.post(user.token, '/accounts/', { name, account_type: 'checking', balance: 100000, currency: 'PHP' })

async function openAllocations(browser, user) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}/allocations`)
  await page.getByRole('button', { name: 'Add Recurring Entry' }).waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native }
}

async function openAdd(page, bank, name) {
  await page.getByRole('button', { name: 'Add Recurring Entry' }).click()
  const form = addForm(page)
  await form.waitFor()
  await h.waitQuiet(page)
  await form.getByRole('button', { name: 'Income', exact: true }).click()
  await field(form, 'name').fill(name)
  await field(form, 'account_id').selectOption({ label: bank.name })
  await field(form, 'amount').fill('1000')
  return form
}

/** The warning's text, or null when it is not shown. */
const warningText = async (form) => ((await warning(form).count()) ? (await warning(form).locator('p').textContent()).trim() : null)
/** The day the warning names, or null. */
const namedDay = async (form) => {
  const text = await warningText(form)
  const m = text && NAMED.exec(text)
  return m ? dayOfLabel(m[1]) : null
}

async function saveAdd(page, form) {
  await page.getByRole('button', { name: 'Save Recurring Entry' }).click()
  await form.waitFor({ state: 'detached' })
  await h.waitQuiet(page)
}

const entryNamed = async (user, name) => {
  const all = await client.get(user.token, '/budget-entries/?limit=100')
  return (all.items ?? all).find((e) => e.name === name)
}
/** The forecast's first occurrence of an entry (`GET /forecast/upcoming`, a year ahead). */
const forecastFirst = async (user, entry) => {
  const body = await client.get(user.token, '/forecast/upcoming?days=365')
  const mine = body.items.filter((i) => i.source === 'budget_entry' && i.name === entry.name).map((i) => i.due_date).sort()
  return mine[0] ?? null
}

/** A past date (well before today) whose cadence steps put the first used date ahead. */
const pastDate = () => `${addDays(manilaToday(), -300)}T09:00`
/** The cadences Add offers of the five; semi-monthly is not offered, so it is checked in Edit. */
const CADENCES = ['monthly', 'weekly', 'quarterly', 'annual']

/** A semi-monthly entry on the 10th and 25th, dated ahead, as the API stores one (Add offers no semi-monthly). */
const seedSemiMonthly = (user, bank, name) =>
  client.post(user.token, '/budget-entries/', {
    entry_type: 'income', currency: 'PHP', cadence: 'semi_monthly', name, amount: 1000,
    account_id: bank.id, next_occurrence: `${addDays(manilaToday(), 40)}T09:00:00`,
    semi_monthly_day_1: 10, semi_monthly_day_2: 25,
  })

async function openEdit(page, name) {
  await page.reload()
  await page.locator('article').filter({ has: page.getByText(name, { exact: true }) }).click()
  const form = editForm(page)
  await form.waitFor()
  await h.waitQuiet(page)
  return form
}

// AC1
async function warningNamesFirstUsedDate(browser) {
  console.log('\n=== warning_names_first_used_date (AC1)')
  const user = await h.makeUser(stack, 'psa')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    const form = await openAdd(page, bank, 'Salary A')
    const today = manilaToday()
    for (const cadence of CADENCES) {
      await field(form, 'cadence').selectOption(cadence)
      await field(form, 'next_occurrence').fill(pastDate())
      await h.check(`warning_names_first_used_date.add.${cadence}`, 'B', async () => {
        const text = await warningText(form)
        const day = await namedDay(form)
        return (day !== null && day >= today) || `warning ${JSON.stringify(text)}`
      })
    }
    await h.check('warning_names_first_used_date.use-next-year-offered', 'B', async () =>
      (await nextYear(form).count()) === 1 || 'no Use next year button')
    await page.getByLabel('Close allocation modal').click()
    await h.waitQuiet(page)

    // Edit: a future-dated entry moved to a past date.
    await client.post(user.token, '/budget-entries/', {
      entry_type: 'income', currency: 'PHP', cadence: 'monthly', name: 'Salary Edit', amount: 1000,
      account_id: bank.id, next_occurrence: `${addDays(today, 10)}T09:00:00`,
    })
    const edit = await openEdit(page, 'Salary Edit')
    await h.check('warning_names_first_used_date.edit.none-as-loaded', 'B', async () => (await warning(edit).count()) === 0 || 'warning before any change')
    await field(edit, 'next_occurrence').fill(pastDate())
    await h.check('warning_names_first_used_date.edit.monthly', 'B', async () => {
      const day = await namedDay(edit)
      return (day !== null && day >= today) || `warning ${JSON.stringify(await warningText(edit))}`
    })
    await page.getByLabel('Close allocation modal').click()
    await h.waitQuiet(page)

    await seedSemiMonthly(user, bank, 'Salary Semi')
    const semi = await openEdit(page, 'Salary Semi')
    await field(semi, 'next_occurrence').fill(pastDate())
    await h.check('warning_names_first_used_date.edit.semi_monthly', 'B', async () => {
      const day = await namedDay(semi)
      return (day !== null && day >= today && ['10', '25', '28', '30', '31'].includes(day.slice(8))) || `warning ${JSON.stringify(await warningText(semi))}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'warning_names_first_used_date', native)
    await ctx.close()
  }
}

async function moveCase(browser, label, value, expected) {
  console.log(`\n=== ${label} (AC2)`)
  const user = await h.makeUser(stack, 'psb')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    const form = await openAdd(page, bank, 'Salary B')
    await field(form, 'next_occurrence').fill(value)
    await h.check(`${label}.warning-shown`, 'S', async () => (await warning(form).count()) === 1 || 'no warning')
    await nextYear(form).click()
    await h.check(`${label}.value`, 'B', async () => {
      const got = await field(form, 'next_occurrence').inputValue()
      return got === expected || `value ${got}, expected ${expected}`
    })
    await h.check(`${label}.warning-gone`, 'B', async () => (await warning(form).count()) === 0 || 'warning still shown')
    await h.check(`${label}.within-max`, 'B', async () => {
      const max = await field(form, 'next_occurrence').getAttribute('max')
      return (max !== null && expected <= max) || `max ${max}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, label, native)
    await ctx.close()
  }
}

const nextYearNumber = () => Number(manilaToday().slice(0, 4)) + 1
// AC2
async function moveToNextYear(browser) {
  const past = pastDate()
  await moveCase(browser, 'move_to_next_year', past, `${nextYearNumber()}${past.slice(4)}`)
}
async function moveOlderDateToNextYear(browser) {
  await moveCase(browser, 'move_older_date_to_next_year', '2019-03-10T08:00', `${nextYearNumber()}-03-10T08:00`)
}
async function moveLeapDayToNextYear(browser) {
  const y = nextYearNumber()
  await moveCase(browser, 'move_leap_day_to_next_year', '2024-02-29T07:00', `${y}-02-${isLeap(y) ? '29' : '28'}T07:00`)
}

// AC3
async function noWarningForFuture(browser) {
  console.log('\n=== no_warning_for_future (AC3)')
  const user = await h.makeUser(stack, 'psc')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    const form = await openAdd(page, bank, 'Salary C')
    const today = manilaToday()
    for (const cadence of CADENCES) {
      await field(form, 'cadence').selectOption(cadence)
      for (const [what, value] of [['today-early', `${today}T00:00`], ['today-late', `${today}T23:59`], ['tomorrow', `${addDays(today, 1)}T09:00`]]) {
        await field(form, 'next_occurrence').fill(value)
        await h.check(`no_warning_for_future.${cadence}.${what}`, 'B', async () => (await warning(form).count()) === 0 || `warning ${await warningText(form)}`)
      }
    }
    await field(form, 'next_occurrence').fill(`${addDays(today, -1)}T23:59`)
    await h.check('no_warning_for_future.yesterday-warns', 'G', async () => (await warning(form).count()) === 1 || 'no warning for yesterday')
    await page.getByLabel('Close allocation modal').click()
    await h.waitQuiet(page)
    await seedSemiMonthly(user, bank, 'Salary Semi')
    const semi = await openEdit(page, 'Salary Semi')
    for (const [what, value] of [['today-early', `${today}T00:00`], ['today-late', `${today}T23:59`], ['tomorrow', `${addDays(today, 1)}T09:00`]]) {
      await field(semi, 'next_occurrence').fill(value)
      await h.check(`no_warning_for_future.semi_monthly.${what}`, 'B', async () => (await warning(semi).count()) === 0 || `warning ${await warningText(semi)}`)
    }
  } finally {
    await d.checkNoNativeDialogs(h, 'no_warning_for_future', native)
    await ctx.close()
  }
}

// AC4 (forecast) and AC6 (the saved date)
async function savedPastDateMatchesWarning(browser) {
  console.log('\n=== saved_past_date_matches_warning (AC4) and save_preserves_selected_past_date (AC6)')
  const user = await h.makeUser(stack, 'psd')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    for (const cadence of CADENCES) {
      const name = `Pay ${cadence}`
      const picked = pastDate()
      const form = await openAdd(page, bank, name)
      await field(form, 'cadence').selectOption(cadence)
      await field(form, 'next_occurrence').fill(picked)
      const named = await namedDay(form)
      await saveAdd(page, form)
      const entry = await entryNamed(user, name)
      await h.check(`saved_past_date_matches_warning.${cadence}.saved`, 'B', () => !!entry || 'entry not saved')
      if (!entry) continue
      await h.check(`saved_past_date_matches_warning.${cadence}.forecast-first`, 'B', async () => {
        const first = await forecastFirst(user, entry)
        return (named !== null && first === named) || `forecast ${first}, warning named ${named}`
      })
      await h.check(`save_preserves_selected_past_date.${cadence}`, 'B', () =>
        entry.next_occurrence.slice(0, 16) === picked || `stored ${entry.next_occurrence}, picked ${picked}`)
    }
    // Semi-monthly (10th and 25th), through Edit.
    await seedSemiMonthly(user, bank, 'Pay semi_monthly')
    const semi = await openEdit(page, 'Pay semi_monthly')
    await field(semi, 'next_occurrence').fill(pastDate())
    const semiNamed = await namedDay(semi)
    await page.getByRole('button', { name: 'Update Recurring Entry' }).click()
    await semi.waitFor({ state: 'detached' })
    await h.waitQuiet(page)
    const semiEntry = await entryNamed(user, 'Pay semi_monthly')
    await h.check('saved_past_date_matches_warning.semi_monthly.forecast-first', 'B', async () => {
      const first = await forecastFirst(user, semiEntry)
      return (semiNamed !== null && first === semiNamed) || `forecast ${first}, warning named ${semiNamed}`
    })
    await h.check('save_preserves_selected_past_date.semi_monthly', 'B', () =>
      semiEntry.next_occurrence.slice(0, 16) === pastDate() || `stored ${semiEntry.next_occurrence}, picked ${pastDate()}`)

    // Edit reopens the picked date as saved.
    const picked = pastDate()
    const edit = await openEdit(page, 'Pay monthly')
    await h.check('save_preserves_selected_past_date.edit-reopens', 'B', async () => {
      const value = await field(edit, 'next_occurrence').inputValue()
      return value === picked || `value ${value}, picked ${picked}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'saved_past_date_matches_warning', native)
    await ctx.close()
  }
}

// AC4 (Due card)
async function dueCardMatchesWarning(browser) {
  console.log('\n=== due_card_matches_warning (AC4)')
  const user = await h.makeUser(stack, 'pse')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    // A monthly date a year back whose day lands 3 to 20 days ahead, so its next step is on
    // the Upcoming tab (tomorrow to 30 days on); days 29 to 31 are skipped (no clamping).
    let target = addDays(manilaToday(), 3)
    while (Number(target.slice(8)) > 28) target = addDays(target, 1)
    const picked = `${Number(target.slice(0, 4)) - 1}${target.slice(4)}T09:00`
    const form = await openAdd(page, bank, 'Salary Due')
    await field(form, 'next_occurrence').fill(picked)
    const named = await namedDay(form)
    await h.check('due_card_matches_warning.named', 'S', () => named === target || `named ${named}, expected ${target}`)
    await saveAdd(page, form)
    const entry = await entryNamed(user, 'Salary Due')

    await page.goto(`${stack.webUrl}/transactions`)
    await page.locator('[data-testid="due-section"]').waitFor()
    await h.waitQuiet(page)
    const rows = await readTab(page, 'upcoming')
    const days = rows.filter((r) => r.source === `budget_entry:${entry.id}`).map((r) => r.day).sort()
    await h.check('due_card_matches_warning.upcoming-next-date', 'B', () =>
      (named !== null && days[0] === named) || `Due card days ${JSON.stringify(days)}, warning named ${named}`)
    // As the API gives it to the card.
    await h.check('due_card_matches_warning.due-api', 'B', async () => {
      const due = await client.get(user.token, '/dashboard/due')
      const first = due.upcoming_occurrences.items.filter((o) => o.entry_id === entry.id).map((o) => o.occurrence_date).sort()[0]
      return first === named || `/dashboard/due first ${first}, warning named ${named}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'due_card_matches_warning', native)
    await ctx.close()
  }
}

// AC6
async function existingRecurrenceResultsUnchanged(browser) {
  console.log('\n=== existing_recurrence_results_unchanged (AC6)')
  const user = await h.makeUser(stack, 'psf')
  const bank = await account(user, 'PS Checking')
  const { ctx, page, native } = await openAllocations(browser, user)
  try {
    const date = `${addDays(manilaToday(), 12)}T09:00`
    const form = await openAdd(page, bank, 'Salary Future')
    await field(form, 'next_occurrence').fill(date)
    await h.check('existing_recurrence_results_unchanged.no-warning', 'B', async () => (await warning(form).count()) === 0 || 'warning shown')
    await saveAdd(page, form)
    const entry = await entryNamed(user, 'Salary Future')
    await h.check('existing_recurrence_results_unchanged.saved-as-picked', 'B', () =>
      entry.next_occurrence.slice(0, 16) === date || `stored ${entry.next_occurrence}`)
    await h.check('existing_recurrence_results_unchanged.forecast-first', 'B', async () => {
      const first = await forecastFirst(user, entry)
      return first === date.slice(0, 10) || `forecast ${first}`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'existing_recurrence_results_unchanged', native)
    await ctx.close()
  }
}

const SCENARIOS = [
  ['warning_names_first_used_date', warningNamesFirstUsedDate],
  ['move_to_next_year', moveToNextYear],
  ['move_older_date_to_next_year', moveOlderDateToNextYear],
  ['move_leap_day_to_next_year', moveLeapDayToNextYear],
  ['no_warning_for_future', noWarningForFuture],
  ['saved_past_date_matches_warning', savedPastDateMatchesWarning],
  ['due_card_matches_warning', dueCardMatchesWarning],
  ['existing_recurrence_results_unchanged', existingRecurrenceResultsUnchanged],
]

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
