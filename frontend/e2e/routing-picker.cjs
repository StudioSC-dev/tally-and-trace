// Browser checks for STU-244: the account routing picker ("Paid From" and "Overflow To" on
// a card's edit form) matches the edited account's owner by `owner_id`, not by display
// name. (a) same-name-owners: two owners with one display name each share an account with
// the same admin; editing the first owner's card offers only that owner's account shared
// with the admin as editor, never the second owner's. Starts its own API and web app
// against a throwaway database (./_local_stack.cjs) and seeds through the API. Not wired
// into CI and not part of `pnpm build`. Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/routing-picker.cjs [scenario]   (a)
const { startLocalStack } = require('./_local_stack.cjs')
const h = require('./_smooth.cjs')
const dialogs = require('./_dialogs.cjs')

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright'
let chromium
try {
  ;({ chromium } = require(playwrightPath))
} catch {
  console.error(`Cannot load Playwright from "${playwrightPath}". Set PLAYWRIGHT_PATH (see frontend/e2e/README.md).`)
  process.exit(2)
}

const only = process.argv[2]

let stack, client, first, second, admin, card, firstBank, firstPrivate, secondBank, adminBank

/** The option values a select offers, without the empty "Not set". */
const offered = (select) =>
  select.locator('option').evaluateAll((options) => options.map((o) => o.value).filter((v) => v !== ''))

// (a) Two owners with the same display name.
async function scenarioA(browser) {
  console.log('\n=== (a) same-name-owners: the picker offers only the edited account owner\'s accounts, by id')
  const seen = (await client.get(admin.token, '/accounts/?limit=100')).items
  const byId = Object.fromEntries(seen.map((a) => [a.id, a]))
  await h.check('a.same-display-name', 'S', async () =>
    (byId[card.id]?.owner_name && byId[card.id].owner_name === byId[secondBank.id]?.owner_name) ||
    `names ${byId[card.id]?.owner_name} / ${byId[secondBank.id]?.owner_name}`)
  await h.check('a.distinct-owner-ids', 'S', async () =>
    (byId[card.id]?.owner_id != null && byId[card.id].owner_id !== byId[secondBank.id]?.owner_id) ||
    `owner ids ${byId[card.id]?.owner_id} / ${byId[secondBank.id]?.owner_id}`)
  await h.check('a.admin-can-add-to-both', 'S', async () =>
    (byId[firstBank.id]?.permissions.can_add_transactions && byId[secondBank.id]?.permissions.can_add_transactions) ||
    'the admin cannot add transactions to both banks')

  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = dialogs.trackNativeDialogs(page)
  try {
    await h.uiLogin(page, stack, admin)
    await page.goto(`${stack.webUrl}/accounts`)
    await page.getByText(card.name, { exact: true }).first().waitFor()
    await h.waitQuiet(page)
    await page.locator('article').filter({ has: page.getByText(card.name, { exact: true }) })
      .locator('[role="button"]').first().click()
    await page.getByRole('button', { name: 'Edit account' }).click()
    const details = page.getByRole('button', { name: 'Show details' })
    if (await details.count()) await details.click()
    const paidFrom = page.locator('label:text-is("Paid From") + select')
    await paidFrom.waitFor()
    await h.waitQuiet(page)
    const want = [String(firstBank.id)]
    await h.check('a.same-name-owners', 'B', async () => {
      const got = await offered(paidFrom)
      return JSON.stringify(got.sort()) === JSON.stringify(want) ||
        `Paid From offers ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`
    })
    await h.check('a.not-the-other-owner', 'B', async () => {
      const got = await offered(paidFrom)
      return !got.includes(String(secondBank.id)) || 'the same-name owner\'s account is offered'
    })
    await paidFrom.selectOption(String(firstBank.id))
    const overflow = page.locator('label:text-is("Overflow To") + select')
    await h.check('a.overflow-same-owner', 'B', async () => {
      const got = await offered(overflow)
      return got.length === 0 || `Overflow To offers ${JSON.stringify(got)} (only the one same-owner account exists)`
    })
    await h.check('a.saves', 'B', async () => {
      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/accounts/${card.id}`))
      await page.getByRole('button', { name: 'Update Account', exact: true }).click()
      const res = await saved
      if (res.status() !== 200) return `PUT ${res.status()}`
      const stored = await client.get(first.token, `/accounts/${card.id}`)
      return stored.payment_account_id === firstBank.id || `payment_account_id ${stored.payment_account_id}`
    })
    await h.check('a.no-native-dialog', 'G', async () => native.count === 0 || native.messages.join('; '))
  } finally {
    await ctx.close()
  }
}

async function setup() {
  // makeUser names a user "User<tag> T.", so one tag gives two owners one display name.
  first = await h.makeUser(stack, 'twin')
  second = await h.makeUser(stack, 'twin')
  admin = await h.makeUser(stack, 'admin')
  card = await client.post(first.token, '/accounts/', {
    name: 'Twin Card', account_type: 'credit', balance: 0, currency: 'PHP',
    billing_cycle_start: 15, days_until_due_date: 21, credit_limit: 50000,
  })
  firstBank = await client.post(first.token, '/accounts/', { name: 'First Twin Bank', account_type: 'checking', balance: 1000, currency: 'PHP' })
  firstPrivate = await client.post(first.token, '/accounts/', { name: 'First Twin Private', account_type: 'checking', balance: 1000, currency: 'PHP' })
  secondBank = await client.post(second.token, '/accounts/', { name: 'Second Twin Bank', account_type: 'checking', balance: 1000, currency: 'PHP' })
  adminBank = await client.post(admin.token, '/accounts/', { name: 'Admin Own Bank', account_type: 'checking', balance: 1000, currency: 'PHP' })
  await client.post(first.token, `/accounts/${card.id}/shares`, { email: admin.email, role: 'admin' })
  await client.post(first.token, `/accounts/${firstBank.id}/shares`, { email: admin.email, role: 'editor' })
  await client.post(second.token, `/accounts/${secondBank.id}/shares`, { email: admin.email, role: 'editor' })
}

const SCENARIOS = [
  ['a', scenarioA],
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
