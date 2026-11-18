// Browser checks for STU-244: receipts in the Transactions action modal. (a) a receipt
// uploaded from the modal is stored and can be viewed there; (b) a receipt or invoice given
// as an external http(s) link is shown as a link, and any other scheme is not; (c) a refused
// upload shows the server's reason and keeps the receipt already stored. Starts its own API
// and web app against a throwaway database (./_local_stack.cjs) and seeds through the API;
// stored values are read back from the API. Not wired into CI and not part of `pnpm build`.
// Run steps: see ./README.md.
//
// Check kinds: [B] behavioural, [S] structural (a failed one makes the run invalid),
// [G] guard. The script ends with RESULT: k/m and exits 0 only when every check passed,
// 1 when any failed, 2 for setup.
//
// Usage: node frontend/e2e/receipts.cjs [scenario]   (a | b | c)
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
const tid = (id) => `[data-testid="${id}"]`

// Two distinct PNGs (1x1 and 2x2), so a kept receipt is told apart from a replacement by its bytes.
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64')

let stack, client, owner, bank, today

const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })

async function debit(description, extra = {}) {
  return client.post(owner.token, '/transactions/', {
    account_id: bank.id, transaction_type: 'debit', amount: 42, description,
    transaction_date: `${today}T00:00:00`, is_posted: true, ...extra,
  })
}

async function apiUpload(txnId, bytes) {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'receipt.png')
  const res = await fetch(`${stack.apiUrl}/api/v1/transactions/${txnId}/upload-receipt`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: form,
  })
  if (res.status >= 300) throw new Error(`upload-receipt ${res.status} ${await res.text()}`)
}

/** The stored receipt's bytes as the API serves them, or the status when it does not. */
async function apiReceipt(txnId) {
  const res = await fetch(`${stack.apiUrl}/api/v1/transactions/${txnId}/receipt`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  })
  return res.ok ? Buffer.from(await res.arrayBuffer()) : res.status
}

const receiptRoute = (txnId) => `/api/v1/transactions/${txnId}/receipt`

async function openModal(browser, description) {
  const { ctx, page } = await h.newPage(browser)
  page.setDefaultTimeout(10000)
  const native = dialogs.trackNativeDialogs(page)
  await h.uiLogin(page, stack, owner)
  await page.goto(`${stack.webUrl}/transactions`)
  const row = page.locator('article[data-transaction-id]').filter({ hasText: description }).first()
  await row.waitFor()
  await h.waitQuiet(page)
  await row.click()
  await page.getByRole('button', { name: 'Close actions modal' }).waitFor()
  return { ctx, page, native }
}

/** Clicks View receipt and waits for the preview image to decode. */
async function viewReceipt(page) {
  await page.locator(tid('view-receipt')).click()
  const img = page.locator(tid('receipt-preview'))
  await img.waitFor()
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return el && el.complete && el.naturalWidth > 0
  }, tid('receipt-preview'))
  return img
}

// (a) Upload from the modal, then view it.
async function scenarioA(browser) {
  console.log('\n=== (a) upload-view: a receipt uploaded from the modal is stored and viewable')
  const description = 'Receipt A hardware'
  const txn = await debit(description)
  const { ctx, page, native } = await openModal(browser, description)
  try {
    await h.check('a.no-receipt-yet', 'S', async () =>
      (await page.locator(tid('view-receipt')).count()) === 0 || 'View receipt shown before any upload')
    await h.check('a.upload-disabled-without-file', 'B', async () =>
      (await page.locator(tid('upload-receipt')).isDisabled()) || 'Upload enabled with no file chosen')
    await page.locator(tid('receipt-file')).setInputFiles({ name: 'till.png', mimeType: 'image/png', buffer: PNG_A })
    await page.locator(tid('upload-receipt')).click()
    await h.check('a.upload-done', 'B', async () =>
      page.locator(tid('receipt-upload-done')).waitFor({ timeout: 10000 }).then(() => true, () => 'no "Receipt uploaded." line'))
    await h.check('a.stored', 'B', async () => {
      const row = await client.get(owner.token, `/transactions/${txn.id}`)
      return row.receipt_url === receiptRoute(txn.id) || `receipt_url ${row.receipt_url}`
    })
    await h.check('a.stored-bytes', 'B', async () => {
      const got = await apiReceipt(txn.id)
      return (Buffer.isBuffer(got) && got.equals(PNG_A)) || `receipt is ${Buffer.isBuffer(got) ? 'other bytes' : got}`
    })
    await h.check('a.view', 'B', async () => {
      const img = await viewReceipt(page)
      const src = await img.getAttribute('src')
      return (src && src.startsWith('blob:')) || `preview src ${src}`
    })
    await h.check('a.no-native-dialog', 'G', async () => native.count === 0 || native.messages.join('; '))
  } finally {
    await ctx.close()
  }
}

// (b) External links are links.
async function scenarioB(browser) {
  console.log('\n=== (b) external-link: a receipt or invoice given as a link shows as a link')
  const description = 'Receipt B online order'
  const receiptLink = 'https://example.com/receipts/b-order.png'
  const invoiceLink = 'https://example.com/invoices/b-order.pdf'
  await debit(description, { receipt_url: receiptLink, invoice_url: invoiceLink })
  const unsafe = 'Receipt B unsafe scheme'
  await debit(unsafe, { receipt_url: 'javascript:alert(1)', invoice_url: 'ftp://example.com/x.pdf' })
  let opened = await openModal(browser, description)
  try {
    const { page } = opened
    for (const [id, href] of [['receipt-link', receiptLink], ['invoice-link', invoiceLink]]) {
      await h.check(`b.${id}`, 'B', async () => {
        const link = page.locator(tid(id))
        if (!(await link.isVisible())) return `no ${id}`
        const got = await link.getAttribute('href')
        const target = await link.getAttribute('target')
        const rel = (await link.getAttribute('rel')) || ''
        if (got !== href) return `href ${got}`
        if (target !== '_blank' || !rel.includes('noopener')) return `target ${target} rel ${rel}`
        return true
      })
    }
    await h.check('b.no-view-button', 'B', async () =>
      (await page.locator(tid('view-receipt')).count()) === 0 || 'View receipt shown for an external link')
    await h.check('b.no-native-dialog', 'G', async () => opened.native.count === 0 || opened.native.messages.join('; '))
  } finally {
    await opened.ctx.close()
  }
  opened = await openModal(browser, unsafe)
  try {
    const { page } = opened
    await h.check('b.unsafe-scheme-not-linked', 'B', async () => {
      const n = (await page.locator(tid('receipt-link')).count()) + (await page.locator(tid('invoice-link')).count())
      return n === 0 || `${n} link(s) shown for a non-http(s) value`
    })
  } finally {
    await opened.ctx.close()
  }
}

// (c) A refused upload keeps the stored receipt.
async function scenarioC(browser) {
  console.log('\n=== (c) upload-rejected-preserves-existing-receipt')
  const description = 'Receipt C groceries'
  const txn = await debit(description)
  await apiUpload(txn.id, PNG_B)
  const before = (await client.get(owner.token, `/transactions/${txn.id}`)).receipt_url
  const { ctx, page, native } = await openModal(browser, description)
  try {
    await h.check('c.existing-shown', 'S', async () =>
      (await page.locator(tid('view-receipt')).isVisible()) || 'no View receipt for the stored receipt')
    let status = null
    page.on('response', (r) => { if (r.url().endsWith(`/transactions/${txn.id}/upload-receipt`)) status = r.status() })
    await page.locator(tid('receipt-file')).setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a receipt') })
    await page.locator(tid('upload-receipt')).click()
    const error = page.locator(tid('receipt-upload-error'))
    await h.check('c.error-shown', 'B', async () => {
      const shown = await error.waitFor({ timeout: 10000 }).then(() => true, () => false)
      if (!shown) return 'no upload error'
      const text = (await error.textContent()) || ''
      return text.includes('File type not allowed') || `error text "${text}"`
    })
    await h.check('c.server-refused', 'S', async () => status === 400 || `upload status ${status}`)
    await h.check('c.input-flagged', 'B', async () =>
      (await page.locator(tid('receipt-file')).getAttribute('aria-describedby')) === 'receipt-upload-error' || 'input not described by the error')
    await h.check('c.no-done-line', 'B', async () =>
      (await page.locator(tid('receipt-upload-done')).count()) === 0 || '"Receipt uploaded." shown after a refusal')
    await h.check('c.stored-unchanged', 'B', async () => {
      const row = await client.get(owner.token, `/transactions/${txn.id}`)
      return row.receipt_url === before || `receipt_url ${row.receipt_url}`
    })
    await h.check('c.bytes-unchanged', 'B', async () => {
      const got = await apiReceipt(txn.id)
      return (Buffer.isBuffer(got) && got.equals(PNG_B)) || `receipt is ${Buffer.isBuffer(got) ? 'other bytes' : got}`
    })
    await h.check('c.still-viewable', 'B', async () => {
      const img = await viewReceipt(page)
      return (await img.isVisible()) || 'preview hidden'
    })
    await h.check('c.no-native-dialog', 'G', async () => native.count === 0 || native.messages.join('; '))
  } finally {
    await ctx.close()
  }
}

async function setup() {
  today = manilaToday()
  owner = await h.makeUser(stack, 'receipts')
  bank = await client.post(owner.token, '/accounts/', { name: 'Receipts Checking', account_type: 'checking', balance: 5000, currency: 'PHP' })
}

const SCENARIOS = [
  ['a', scenarioA],
  ['b', scenarioB],
  ['c', scenarioC],
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
