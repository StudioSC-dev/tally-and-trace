// Shared helpers for the in-app dialog checks (STU-410). Pure helpers over a Playwright
// page: a native-dialog tracker (the browser's alert, confirm and prompt must never fire)
// and the in-app Confirm dialog's locators. It starts nothing itself.
//
// Usage:
//   const d = require('./_dialogs.cjs')
//   const native = d.trackNativeDialogs(page)
//   const cd = d.confirmDialog(page)
//   await cd.dialog.waitFor(); await cd.cancel.click()
//   await d.checkNoNativeDialogs(h, 'a', native)

const tid = (id) => `[data-testid="${id}"]`

/**
 * Counts, logs and dismisses every native dialog the page opens. Returns
 * { count, messages }, both live getters.
 */
function trackNativeDialogs(page) {
  const state = { count: 0, messages: [] }
  page.on('dialog', (dialog) => {
    state.count++
    const text = `${dialog.type()}: ${dialog.message()}`
    state.messages.push(text)
    console.log(`  NOTE native dialog ${text}`)
    dialog.dismiss().catch(() => {})
  })
  return {
    get count() { return state.count },
    get messages() { return [...state.messages] },
  }
}

/** The in-app Confirm dialog's locators. */
function confirmDialog(page) {
  return {
    dialog: page.locator(tid('confirm-dialog')),
    overlay: page.locator(tid('confirm-dialog-overlay')),
    title: page.locator(tid('confirm-dialog-title')),
    message: page.locator(tid('confirm-dialog-message')),
    cancel: page.locator(tid('confirm-dialog-cancel')),
    accept: page.locator(tid('confirm-dialog-confirm')),
    error: page.locator(tid('confirm-dialog-error')),
  }
}

/** The `<scenario>.no-native-dialog` check every scenario ends with: the tracker counted 0. */
function checkNoNativeDialogs(h, scenario, tracker) {
  return h.check(`${scenario}.no-native-dialog`, 'B', async () =>
    tracker.count === 0 || `${tracker.count} native dialog(s): ${JSON.stringify(tracker.messages)}`)
}

/** The data-testid (else tag name) of the focused element. */
function activeTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
}

/** Whether #root, the app shell or the Confirm host still carries `inert`: [] when none does. */
function leftoverInert(page) {
  return page.evaluate(() =>
    ['#root', '[data-app-shell]', '[data-confirm-host]'].filter((sel) => document.querySelector(sel)?.hasAttribute('inert')))
}

module.exports = { trackNativeDialogs, confirmDialog, checkNoNativeDialogs, activeTestId, leftoverInert }
