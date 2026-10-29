// Browser checks for STU-410 on sharing, the wishlist and accounts: changing a share's
// role, stopping a share, leaving a share or a Household, deleting a wishlist item and
// deleting an account all ask through the in-app Confirm dialog, never the browser's.
// (a) a role change cancelled keeps the old role and sends nothing; (b) a confirmed role
// change sends one PATCH; (c) stopping an account share or the Household share; (d)
// leaving an account share and a Household; (e) a wishlist delete, with a refusal kept in
// the dialog; (f) an account delete, with a refusal kept in the dialog; (g) a refused
// active toggle shows in the account actions modal. Every scenario checks that no browser
// dialog fired.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/dialogs-sharing.cjs [scenario]
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

let stack, client, owner, other

const tid = (id) => `[data-testid="${id}"]`
const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const sent = (log, method, pattern) => log.filter((r) => r.method === method && pattern.test(pathOf(r.url))).length
const isMethod = (method, pattern) => (r) => r.method() === method && pattern.test(pathOf(r.url()))

const seedAccount = (user, name) =>
  client.post(user.token, '/accounts/', { name, account_type: 'checking', balance: 100, currency: 'PHP' })
const shareAccount = (account, user, role) =>
  client.post(owner.token, `/accounts/${account.id}/shares`, { email: user.email, role })

/** A fresh signed-in page on `path`, its native dialogs tracked and its requests logged. */
async function openAs(browser, user, path, waitText) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, user)
  await page.goto(`${stack.webUrl}${path}`)
  if (waitText) await page.getByText(waitText).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

/** Opens the account actions modal for `name` on the Accounts page. */
async function openAccountActions(page, name) {
  await page.locator('div[role="button"]').filter({ hasText: name }).first().click()
  await page.locator(tid('share-account')).waitFor()
}

/** Opens the Share dialog for `name` and returns its first role select. */
async function openShareDialog(page, name) {
  await openAccountActions(page, name)
  await page.locator(tid('share-account')).click()
  await page.locator(tid('share-row-role')).first().waitFor()
  await h.waitQuiet(page)
}

const shown = (cd) => cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)
const closed = (cd) => cd.dialog.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
const noInert = async (page) => {
  const left = await d.leftoverInert(page)
  return left.length === 0 || `still inert: ${left.join(', ')}`
}

// (a) A role change, cancelled: the select keeps the old role and nothing is sent.
async function scenarioA(browser) {
  console.log('\n=== (a) change a role: Cancel keeps the old role and sends nothing')
  const account = await seedAccount(owner, 'Dialog A Shared')
  await shareAccount(account, other, 'editor')
  const { ctx, page, native, log } = await openAs(browser, owner, '/accounts', account.name)
  const cd = d.confirmDialog(page)
  try {
    await openShareDialog(page, account.name)
    const select = page.locator(tid('share-row-role')).first()
    await select.focus()
    await select.selectOption('viewer')
    await h.check('a.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await h.check('a.default-tone', 'B', async () => {
      const label = ((await cd.accept.textContent().catch(() => null)) || '').trim()
      return label === 'Change role' || `label ${JSON.stringify(label)}`
    })
    await h.check('a.focus-cancel', 'B', async () => {
      const active = await d.activeTestId(page)
      return active === 'confirm-dialog-cancel' || `active ${active}`
    })
    await cd.cancel.click()
    await h.check('a.closed', 'B', async () => (await closed(cd)) || 'dialog still open')
    await h.waitQuiet(page)
    await h.check('a.role-unchanged', 'B', async () => {
      const value = await select.inputValue()
      return value === 'editor' || `select shows ${value}`
    })
    await h.check('a.nothing-sent', 'B', async () => {
      const n = sent(log, 'PATCH', /\/shares\/\d+$/)
      return n === 0 || `${n} PATCH request(s)`
    })
    await h.check('a.share-dialog-still-open', 'B', async () =>
      (await page.locator(tid('share-dialog')).isVisible()) || 'the share dialog closed')
    await h.check('a.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) A role change, confirmed: one PATCH and the select shows the new role.
async function scenarioB(browser) {
  console.log('\n=== (b) change a role: Confirm sends one PATCH')
  const account = await seedAccount(owner, 'Dialog B Shared')
  await shareAccount(account, other, 'editor')
  const { ctx, page, native, log } = await openAs(browser, owner, '/accounts', account.name)
  const cd = d.confirmDialog(page)
  try {
    await openShareDialog(page, account.name)
    const select = page.locator(tid('share-row-role')).first()
    await select.selectOption('viewer')
    await h.check('b.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await h.check('b.message', 'B', async () => {
      const text = (await cd.message.textContent()) || ''
      return (text.includes('editor') && text.includes('viewer')) || `message ${JSON.stringify(text)}`
    })
    await cd.accept.click()
    await h.check('b.closed', 'B', async () => (await closed(cd)) || 'dialog still open')
    await h.waitQuiet(page)
    await h.check('b.one-patch', 'B', async () => {
      const n = sent(log, 'PATCH', /\/shares\/\d+$/)
      return n === 1 || `${n} PATCH request(s)`
    })
    await h.check('b.role-changed', 'B', async () => {
      const value = await select.inputValue()
      return value === 'viewer' || `select shows ${value}`
    })
    await h.check('b.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) Stop sharing an account (Cancel sends nothing, Confirm one DELETE), then the Household.
async function scenarioC(browser) {
  console.log('\n=== (c) stop sharing: an account share, then the Household share')
  const account = await seedAccount(owner, 'Dialog C Shared')
  await shareAccount(account, other, 'viewer')
  const { ctx, page, native, log } = await openAs(browser, owner, '/accounts', account.name)
  const cd = d.confirmDialog(page)
  try {
    await openShareDialog(page, account.name)
    const remove = page.locator(tid('share-remove')).first()
    await remove.click()
    await h.check('c.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await h.check('c.confirm-label', 'B', async () => {
      const label = ((await cd.accept.textContent().catch(() => null)) || '').trim()
      return label === 'Stop sharing' || `label ${JSON.stringify(label)}`
    })
    await cd.cancel.click()
    await closed(cd)
    await h.waitQuiet(page)
    await h.check('c.cancel-sends-nothing', 'B', async () => {
      const n = sent(log, 'DELETE', /\/shares\/\d+$/)
      return n === 0 || `${n} DELETE request(s)`
    })
    await h.check('c.cancel-focus-opener', 'B', async () => {
      const back = await remove.evaluate((el) => el === document.activeElement).catch(() => false)
      return back || `active ${await d.activeTestId(page)}`
    })
    await remove.click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await cd.accept.click()
    await closed(cd)
    await h.waitQuiet(page)
    await h.check('c.one-delete', 'B', async () => {
      const n = sent(log, 'DELETE', /\/shares\/\d+$/)
      return n === 1 || `${n} DELETE request(s)`
    })
    await h.check('c.share-gone', 'B', async () => {
      const n = await page.locator(tid('share-row')).count()
      return n === 0 || `${n} share row(s) remain`
    })
    await h.check('c.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'c', native)
    await ctx.close()
  }

  // The Household share, from Settings.
  await client.post(owner.token, '/tags/household/shares', { email: other.email })
  const second = await openAs(browser, owner, '/settings', null)
  const cd2 = d.confirmDialog(second.page)
  try {
    await second.page.locator(tid('household-share-remove')).first().waitFor()
    await second.page.locator(tid('household-share-remove')).first().click()
    await h.check('c.household-shown', 'B', async () => (await shown(cd2)) || 'no confirm-dialog')
    await cd2.accept.click()
    await closed(cd2)
    await h.waitQuiet(second.page)
    await h.check('c.household-one-delete', 'B', async () => {
      const n = sent(second.log, 'DELETE', /\/shares\/\d+$/)
      return n === 1 || `${n} DELETE request(s)`
    })
    await h.check('c.household-gone', 'B', async () => {
      const n = await second.page.locator(tid('household-share-row')).count()
      return n === 0 || `${n} Household share row(s) remain`
    })
  } finally {
    await d.checkNoNativeDialogs(h, 'c-household', second.native)
    await second.ctx.close()
  }
}

// (d) The second user leaves an account share and a Household.
async function scenarioD(browser) {
  console.log('\n=== (d) leave a share and leave a Household')
  const recipient = await h.makeUser(stack, 'dleave')
  const account = await seedAccount(owner, 'Dialog D Shared')
  await shareAccount(account, recipient, 'viewer')
  await client.post(owner.token, '/tags/household/shares', { email: recipient.email })
  const { ctx, page, native, log } = await openAs(browser, recipient, '/accounts', account.name)
  const cd = d.confirmDialog(page)
  try {
    const leave = page.locator(tid('shared-with-me-leave')).first()
    await leave.click()
    await h.check('d.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await cd.cancel.click()
    await closed(cd)
    await h.waitQuiet(page)
    await h.check('d.cancel-sends-nothing', 'B', async () => {
      const n = log.filter((r) => r.method === 'DELETE').length
      return n === 0 || `${n} DELETE request(s)`
    })
    await h.check('d.row-remains', 'B', async () =>
      (await page.locator(tid('shared-with-me-row')).count()) === 1 || 'the share row is gone')
    await leave.click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await cd.accept.click()
    await closed(cd)
    await h.waitQuiet(page)
    await h.check('d.left-share', 'B', async () => {
      const n = await page.locator(tid('shared-with-me-row')).count()
      const deletes = log.filter((r) => r.method === 'DELETE').length
      return (n === 0 && deletes === 1) || `rows ${n}, DELETE ${deletes}`
    })
    const household = page.locator(tid('shared-with-me-household-leave')).first()
    await household.click()
    await h.check('d.household-shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await cd.accept.click()
    await closed(cd)
    await h.waitQuiet(page)
    await h.check('d.left-household', 'B', async () => {
      const n = await page.locator(tid('shared-with-me-household-row')).count()
      const deletes = log.filter((r) => r.method === 'DELETE').length
      return (n === 0 && deletes === 2) || `rows ${n}, DELETE ${deletes}`
    })
    await h.check('d.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'd', native)
    await ctx.close()
  }
}

// (e) A wishlist delete: a refusal stays in the dialog, then Confirm deletes it.
async function scenarioE(browser) {
  console.log('\n=== (e) delete a wishlist item: a refusal stays in the dialog; Confirm deletes it')
  const user = await h.makeUser(stack, 'wish')
  const item = await client.post(user.token, '/wishlist/', { name: 'E Standing Desk', estimated_cost: 12000, currency: 'PHP', priority: 'high' })
  const { ctx, page, native, log } = await openAs(browser, user, '/allocations', null)
  const cd = d.confirmDialog(page)
  let fail = null
  try {
    await page.getByRole('button', { name: 'Wishlist', exact: true }).click()
    await page.getByText(item.name).first().waitFor()
    await h.waitQuiet(page)
    const del = page.locator('button[title="Delete"]').first()
    fail = await h.failWith(page, isMethod('DELETE', new RegExp(`/wishlist/${item.id}$`)), 500, { times: 1 })
    await del.click()
    await h.check('e.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await h.check('e.message', 'B', async () => {
      const text = (await cd.message.textContent()) || ''
      return text.includes(item.name) || `message ${JSON.stringify(text)}`
    })
    await cd.accept.click()
    await cd.error.waitFor({ timeout: 5000 }).catch(() => null)
    await h.check('e.refusal-in-dialog', 'B', async () => {
      const text = (await cd.error.textContent().catch(() => null)) || ''
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('e.stays-open', 'B', async () => (await cd.dialog.isVisible()) || 'dialog closed')
    await cd.accept.click()
    await h.check('e.closed', 'B', async () => (await closed(cd)) || 'dialog still open')
    await h.waitQuiet(page)
    await h.check('e.deleted', 'B', async () => {
      const n = await page.getByText(item.name).count()
      const deletes = sent(log, 'DELETE', new RegExp(`/wishlist/${item.id}$`))
      return (n === 0 && deletes === 2) || `rows ${n}, DELETE ${deletes}`
    })
    await h.check('e.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'e', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (f) An account delete: Cancel sends nothing, a refusal stays in the dialog, Confirm deletes.
async function scenarioF(browser) {
  console.log('\n=== (f) delete an account: Cancel; a refusal stays in the dialog; Confirm deletes it')
  const account = await seedAccount(owner, 'Dialog F Doomed')
  const { ctx, page, native, log } = await openAs(browser, owner, '/accounts', account.name)
  const cd = d.confirmDialog(page)
  const isDelete = new RegExp(`/accounts/${account.id}$`)
  let fail = null
  try {
    await openAccountActions(page, account.name)
    const del = page.getByRole('button', { name: 'Delete account', exact: true })
    await del.click()
    await h.check('f.shown', 'B', async () => (await shown(cd)) || 'no confirm-dialog')
    await h.check('f.focus-cancel', 'B', async () => {
      const active = await d.activeTestId(page)
      return active === 'confirm-dialog-cancel' || `active ${active}`
    })
    await page.keyboard.press('Escape')
    await h.check('f.escape-closes', 'B', async () => (await closed(cd)) || 'dialog still open')
    await h.check('f.escape-keeps-action-modal', 'B', async () =>
      (await page.locator(tid('share-account')).isVisible()) || 'the actions modal closed with the Confirm')
    await h.check('f.cancel-sends-nothing', 'B', async () => {
      const n = sent(log, 'DELETE', isDelete)
      return n === 0 || `${n} DELETE request(s)`
    })
    fail = await h.failWith(page, isMethod('DELETE', isDelete), 500, { times: 1 })
    await del.click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await cd.accept.click()
    await cd.error.waitFor({ timeout: 5000 }).catch(() => null)
    await h.check('f.refusal-in-dialog', 'B', async () => {
      const text = (await cd.error.textContent().catch(() => null)) || ''
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('f.stays-open', 'B', async () => (await cd.dialog.isVisible()) || 'dialog closed')
    await cd.accept.click()
    await h.check('f.closed', 'B', async () => (await closed(cd)) || 'dialog still open')
    await h.waitQuiet(page)
    await h.check('f.deleted', 'B', async () => {
      const deletes = sent(log, 'DELETE', isDelete)
      const modal = await page.locator(tid('share-account')).count()
      // An account delete is soft: the list may still show it, but the API reports it inactive.
      const list = await client.get(owner.token, '/accounts/')
      const row = (Array.isArray(list) ? list : list.items).find((a) => a.id === account.id)
      const gone = !row || row.is_active === false
      return (deletes === 2 && modal === 0 && gone) || `DELETE ${deletes}, modal ${modal}, account ${JSON.stringify(row && { is_active: row.is_active })}`
    })
    await h.check('f.no-inert-left', 'B', () => noInert(page))
  } finally {
    await d.checkNoNativeDialogs(h, 'f', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (g) A refused active toggle shows the server's message in the actions modal.
async function scenarioG(browser) {
  console.log('\n=== (g) toggle active with a forced 500: the actions modal shows the reason')
  const account = await seedAccount(owner, 'Dialog G Toggle')
  const { ctx, page, native } = await openAs(browser, owner, '/accounts', account.name)
  const error = page.locator(tid('account-action-error'))
  let fail = null
  try {
    await openAccountActions(page, account.name)
    fail = await h.failWith(page, isMethod('PUT', new RegExp(`/accounts/${account.id}$`)), 500, { times: 1 })
    await page.getByRole('button', { name: /Mark as inactive|Activate account/ }).click()
    await error.waitFor({ timeout: 5000 }).catch(() => null)
    await h.check('g.error-shown', 'B', async () => {
      const text = (await error.textContent().catch(() => null)) || ''
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('g.error-role', 'B', async () =>
      (await error.getAttribute('role').catch(() => null)) === 'alert' || 'error line is not role=alert')
    await h.check('g.modal-stays', 'B', async () =>
      (await page.locator(tid('share-account')).isVisible()) || 'the actions modal closed')
    await page.getByRole('button', { name: /Mark as inactive|Activate account/ }).click()
    await h.waitQuiet(page)
    await h.check('g.error-clears-on-retry', 'B', async () =>
      (await error.count()) === 0 || 'the error is still shown after a good retry')
  } finally {
    await d.checkNoNativeDialogs(h, 'g', native)
    await fail?.stop()
    await ctx.close()
  }
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['d', scenarioD],
  ['e', scenarioE],
  ['f', scenarioF],
  ['g', scenarioG],
]

;(async () => {
  process.on('unhandledRejection', (e) => console.log(`  NOTE unhandled rejection: ${e && e.message ? e.message.split('\n')[0] : e}`))
  stack = await startLocalStack()
  client = h.apiClient(stack)
  const browser = await chromium.launch()
  try {
    owner = await h.makeUser(stack, 'sharer')
    other = await h.makeUser(stack, 'sharee')
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
