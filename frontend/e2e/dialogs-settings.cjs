// Browser checks for STU-410 on Settings: deleting a category or a tag asks through the
// in-app Confirm dialog, never the browser's confirm. (a) the dialog's semantics, focus,
// Tab trap and Escape; (b) Confirm deletes; (c) a refused delete keeps the dialog open with
// the server's reason; (d) a tag delete, whose failure goes to the tag list's alert;
// (e) a move to another page before accepting closes it and sends nothing; (f) a move
// while its delete is held closes it for good, with no error and one request.
// Starts its own API and web app against a throwaway database (./_local_stack.cjs) and
// seeds through the API. Not wired into CI and not part of `pnpm build`. Run steps: see
// ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/dialogs-settings.cjs [scenario]
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

let stack, client, owner

const pathOf = (url) => new URL(url).pathname.replace(/\/$/, '')
const isDelete = (segment, id) => (r) => r.method() === 'DELETE' && pathOf(r.url()).endsWith(`/${segment}/${id}`)
const deletesIn = (log, segment, id) =>
  log.filter((r) => r.method === 'DELETE' && pathOf(r.url).endsWith(`/${segment}/${id}`)).length

const categoryRow = (page, name) => page.locator('li').filter({ hasText: name })
const categoryDelete = (page, name) => categoryRow(page, name).getByRole('button', { name: 'Delete', exact: true })
const tagDelete = (page, name) => page.getByRole('button', { name: `Delete tag ${name}`, exact: true })

const seedCategory = (name) => client.post(owner.token, '/categories/', { name, color: '#16a34a', is_expense: true })
const seedTag = (name) => client.post(owner.token, '/tags/', { name })

/** A fresh signed-in page on Settings, its native dialogs tracked and its requests logged. */
async function openSettings(browser, rowText) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/settings`)
  await page.getByText(rowText, { exact: true }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

/**
 * Like openSettings, but reaches Settings through the user menu (a client-side move), so
 * Back is a history pop inside the app, not a new document. Marks the window to prove it.
 */
async function openSettingsInApp(browser, rowText) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = d.trackNativeDialogs(page)
  const log = h.logRequests(page)
  await h.uiLogin(page, stack, owner)
  await h.waitQuiet(page)
  await page.evaluate(() => { window.__stu410SameDocument = true })
  await page.locator('nav button').filter({ hasText: 'Usersettings' }).first().click()
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.waitForURL((url) => url.pathname === '/settings')
  await page.getByText(rowText, { exact: true }).first().waitFor()
  await h.waitQuiet(page)
  return { ctx, page, native, log }
}

const sameDocument = (page) => page.evaluate(() => window.__stu410SameDocument === true).catch(() => false)

// (a) The dialog: semantics, focus on Cancel, Tab stays inside, Escape cancels.
async function scenarioA(browser) {
  console.log('\n=== (a) delete a category: the in-app dialog; Escape cancels and sends nothing')
  const category = await seedCategory('Dialog A Category')
  const { ctx, page, native, log } = await openSettings(browser, category.name)
  const cd = d.confirmDialog(page)
  try {
    const opener = categoryDelete(page, category.name)
    await opener.click()
    await h.check('a.shown', 'B', async () =>
      (await cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no confirm-dialog')
    await h.check('a.message', 'B', async () => {
      const text = await cd.message.textContent()
      return (text || '').includes(`"${category.name}"`) || `message ${JSON.stringify(text)}`
    })
    await h.check('a.semantics', 'B', async () => {
      const got = await cd.dialog.evaluate((el) => ({
        role: el.getAttribute('role'),
        modal: el.getAttribute('aria-modal'),
        labelled: document.getElementById(el.getAttribute('aria-labelledby') || '')?.getAttribute('data-testid') ?? null,
        described: document.getElementById(el.getAttribute('aria-describedby') || '')?.getAttribute('data-testid') ?? null,
        outsideRoot: !document.getElementById('root')?.contains(el),
      }))
      const want = { role: 'alertdialog', modal: 'true', labelled: 'confirm-dialog-title', described: 'confirm-dialog-message', outsideRoot: true }
      return JSON.stringify(got) === JSON.stringify(want) || `got ${JSON.stringify(got)}`
    })
    await h.check('a.page-inert', 'B', async () => {
      const inert = await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert') ?? false)
      return inert || '#root is not inert while the dialog is open'
    })
    await h.check('a.focus-cancel', 'B', async () => {
      const active = await d.activeTestId(page)
      return active === 'confirm-dialog-cancel' || `active ${active}`
    })
    await h.check('a.tab-cycles-inside', 'B', async () => {
      const seen = []
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        seen.push(await d.activeTestId(page))
      }
      const want = ['confirm-dialog-confirm', 'confirm-dialog-cancel', 'confirm-dialog-confirm', 'confirm-dialog-cancel']
      return JSON.stringify(seen) === JSON.stringify(want) || `focus went ${JSON.stringify(seen)}`
    })
    // Host dialogs listen for Escape on document in the bubble phase; the Confirm must not leak it.
    await page.evaluate(() => {
      window.__escapeLeaks = 0
      window.__escapeCounter = (e) => { if (e.key === 'Escape') window.__escapeLeaks += 1 }
      document.addEventListener('keydown', window.__escapeCounter)
    })
    await page.keyboard.press('Escape')
    await h.check('a.escape-closes', 'B', async () =>
      (await cd.dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'dialog still open after Escape')
    await h.check('a.escape-not-leaked', 'B', async () => {
      const leaks = await page.evaluate(() => {
        document.removeEventListener('keydown', window.__escapeCounter)
        return window.__escapeLeaks
      })
      return leaks === 0 || `${leaks} Escape keydown(s) reached document in the bubble phase`
    })
    await h.check('a.focus-returns', 'B', async () => {
      const back = await opener.evaluate((el) => el === document.activeElement).catch(() => false)
      return back || `active ${await d.activeTestId(page)}`
    })
    await h.waitQuiet(page)
    await h.check('a.nothing-sent', 'B', async () => {
      const n = deletesIn(log, 'categories', category.id)
      return n === 0 || `${n} DELETE request(s)`
    })
    await h.check('a.row-remains', 'B', async () =>
      (await categoryRow(page, category.name).first().isVisible()) || 'the category is gone')
    await h.check('a.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'a', native)
    await ctx.close()
  }
}

// (b) Confirm deletes it: one DELETE and the API reports it inactive. Settings lists
// inactive categories too (a soft delete), so the row stays, and the screen loader's
// restore puts focus back on its Delete button once the reload lands.
async function scenarioB(browser) {
  console.log('\n=== (b) delete a category: Confirm deletes it')
  const category = await seedCategory('Dialog B Category')
  const { ctx, page, native, log } = await openSettings(browser, category.name)
  const cd = d.confirmDialog(page)
  try {
    const opener = categoryDelete(page, category.name)
    await opener.click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await h.check('b.confirm-label', 'B', async () => {
      const text = (await cd.accept.textContent().catch(() => null)) || ''
      return text.trim() === 'Delete category' || `label ${JSON.stringify(text)}`
    })
    await cd.accept.click()
    await cd.dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('b.one-delete', 'B', async () => {
      const n = deletesIn(log, 'categories', category.id)
      return n === 1 || `${n} DELETE request(s)`
    })
    await h.check('b.closed', 'B', async () => (await cd.dialog.count()) === 0 || 'dialog still open')
    await h.check('b.deleted', 'B', async () => {
      const list = await client.get(owner.token, '/categories/')
      const row = (Array.isArray(list) ? list : list.items).find((c) => c.id === category.id)
      return row?.is_active === false || `category ${JSON.stringify(row)}`
    })
    await h.check('b.focus-opener', 'B', async () => {
      const back = await opener.evaluate((el) => el === document.activeElement).catch(() => false)
      return back || `active ${await d.activeTestId(page)}`
    })
    await h.check('b.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'b', native)
    await ctx.close()
  }
}

// (c) A refused delete: the server's reason in the dialog, which stays open; Cancel closes it.
async function scenarioC(browser) {
  console.log('\n=== (c) delete a category: a refused delete keeps the dialog open with the reason')
  const category = await seedCategory('Dialog C Category')
  const { ctx, page, native } = await openSettings(browser, category.name)
  const cd = d.confirmDialog(page)
  let fail = null
  try {
    fail = await h.failWith(page, isDelete('categories', category.id), 500)
    await categoryDelete(page, category.name).click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await cd.accept.click()
    await cd.error.waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('c.error-shown', 'B', async () => {
      const text = (await cd.error.textContent().catch(() => null)) || ''
      return text.includes('stu335 injected failure 500') || `error ${JSON.stringify(text)}`
    })
    await h.check('c.error-role', 'B', async () =>
      (await cd.error.getAttribute('role').catch(() => null)) === 'alert' || 'error line is not role=alert')
    await h.check('c.stays-open', 'B', async () => (await cd.dialog.isVisible()) || 'dialog closed')
    await h.check('c.one-delete', 'B', async () => fail.hits === 1 || `${fail.hits} DELETE request(s)`)
    await h.check('c.buttons-enabled', 'B', async () =>
      (!(await cd.cancel.isDisabled()) && !(await cd.accept.isDisabled())) || 'a button is still disabled')
    await h.check('c.focus-inside', 'B', async () => {
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="confirm-dialog"]'))
      return inside || `active ${await d.activeTestId(page)}`
    })
    await cd.cancel.click()
    await h.check('c.cancel-closes', 'B', async () =>
      (await cd.dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'dialog still open')
    await h.waitQuiet(page)
    await h.check('c.row-remains', 'B', async () =>
      (await categoryRow(page, category.name).first().isVisible()) || 'the category is gone')
    await h.check('c.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'c', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (d) A tag delete: the dialog, a refusal in the tag list's alert, then a delete.
async function scenarioD(browser) {
  console.log('\n=== (d) delete a tag: the dialog; a refusal goes to the tag list; Confirm deletes it')
  const tag = await seedTag('Dialog D Tag')
  const { ctx, page, native, log } = await openSettings(browser, tag.name)
  const cd = d.confirmDialog(page)
  const tagAlert = page.locator('[data-testid="tags-section"] p[role="alert"]')
  let fail = null
  try {
    fail = await h.failWith(page, isDelete('tags', tag.id), 500, { times: 1 })
    await tagDelete(page, tag.name).click()
    await h.check('d.shown', 'B', async () =>
      (await cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no confirm-dialog')
    await h.check('d.message', 'B', async () => {
      const text = (await cd.message.textContent().catch(() => null)) || ''
      return text === `Delete tag "${tag.name}"? It is removed from every record that has it.` || `message ${JSON.stringify(text)}`
    })
    await cd.accept.click()
    await tagAlert.waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('d.failure-in-list', 'B', async () => {
      const text = (await tagAlert.textContent().catch(() => null)) || ''
      return text.includes('stu335 injected failure 500') || `tag list alert ${JSON.stringify(text)}`
    })
    await h.check('d.closed-after-failure', 'B', async () => (await cd.dialog.count()) === 0 || 'dialog still open')
    await h.check('d.row-remains', 'B', async () =>
      (await page.locator('[data-testid="tag-row"]').filter({ hasText: tag.name }).count()) === 1 || 'the tag is gone')

    await tagDelete(page, tag.name).click()
    await cd.dialog.waitFor({ timeout: 3000 }).catch(() => null)
    await cd.accept.click()
    await cd.dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('d.two-deletes', 'B', async () => {
      const n = deletesIn(log, 'tags', tag.id)
      return n === 2 || `${n} DELETE request(s)`
    })
    await h.check('d.row-gone', 'B', async () =>
      (await h.expectAbsentFor(page, page.locator('[data-testid="tag-row"]').filter({ hasText: tag.name }), 500)) || 'the tag is still listed')
    await h.check('d.alert-cleared', 'B', async () => (await tagAlert.count()) === 0 || 'the old failure is still shown')
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'd', native)
    await fail?.stop()
    await ctx.close()
  }
}

// (e) Back before accepting: the dialog closes with its page, nothing is sent.
async function scenarioE(browser) {
  console.log('\n=== (e) moving to another page before accepting closes the dialog and sends nothing')
  const category = await seedCategory('Dialog E Category')
  const { ctx, page, native, log } = await openSettingsInApp(browser, category.name)
  const cd = d.confirmDialog(page)
  try {
    await categoryDelete(page, category.name).click()
    await h.check('e.shown', 'S', async () =>
      (await cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no confirm-dialog')
    // The shell is inert, so the move uses history, not a click.
    await page.goBack()
    await page.waitForURL((url) => url.pathname === '/').catch(() => null)
    await h.check('e.same-document', 'S', async () => (await sameDocument(page)) || 'Back loaded a new document')
    await h.check('e.dialog-gone', 'B', async () =>
      (await cd.dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'dialog still open on the dashboard')
    await h.waitQuiet(page)
    await h.check('e.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
    await page.goForward()
    await page.waitForURL((url) => url.pathname === '/settings').catch(() => null)
    await page.getByText(category.name, { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => null)
    await h.waitQuiet(page)
    await h.check('e.category-remains', 'B', async () =>
      (await categoryRow(page, category.name).first().isVisible()) || 'the category is gone')
    await h.check('e.dialog-stays-gone', 'B', async () => (await cd.dialog.count()) === 0 || 'dialog open again')
    await h.check('e.nothing-sent', 'B', async () => {
      const n = deletesIn(log, 'categories', category.id)
      return n === 0 || `${n} DELETE request(s)`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'e', native)
    await ctx.close()
  }
}

// (f) Back while the delete is held: the dialog goes for good, no error, one request.
async function scenarioF(browser) {
  console.log('\n=== (f) moving to another page while the delete is held closes the dialog for good')
  const category = await seedCategory('Dialog F Category')
  const { ctx, page, native, log } = await openSettingsInApp(browser, category.name)
  const cd = d.confirmDialog(page)
  let gate = null
  try {
    gate = await h.gate(page, isDelete('categories', category.id))
    await categoryDelete(page, category.name).click()
    await h.check('f.shown', 'S', async () =>
      (await cd.dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) || 'no confirm-dialog')
    await cd.accept.click()
    await h.check('f.held', 'S', async () => (await gate.waitHits(1)) || 'the DELETE was not held')
    await page.goBack()
    await page.waitForURL((url) => url.pathname === '/').catch(() => null)
    await h.check('f.same-document', 'S', async () => (await sameDocument(page)) || 'Back loaded a new document')
    await h.check('f.dialog-gone', 'B', async () =>
      (await cd.dialog.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)) || 'dialog still open while held')
    gate.release({ disarm: true })
    await h.waitQuiet(page)
    await h.check('f.stays-gone', 'B', async () =>
      (await h.expectAbsentFor(page, cd.dialog, 1000)) || 'dialog came back after the late settle')
    await h.check('f.no-error', 'B', async () => (await cd.error.count()) === 0 || 'confirm-dialog-error shown')
    await h.check('f.one-delete', 'B', async () => {
      const n = deletesIn(log, 'categories', category.id)
      return (gate.hits === 1 && n === 1) || `gate ${gate.hits}, log ${n}`
    })
    await h.check('f.no-inert-left', 'B', async () => {
      const left = await d.leftoverInert(page)
      return left.length === 0 || `still inert: ${left.join(', ')}`
    })
  } finally {
    // Reached even when the scenario throws: a native dialog is a failure either way.
    await d.checkNoNativeDialogs(h, 'f', native)
    gate?.release({ disarm: true })
    await ctx.close()
  }
}

async function setup() {
  owner = await h.makeUser(stack, 'settings')
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
  ['d', scenarioD],
  ['e', scenarioE],
  ['f', scenarioF],
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
