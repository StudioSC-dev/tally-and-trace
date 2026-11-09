// Shared helper for the account and category chip pickers (GroupedPicker). A picker with
// more than 8 options shows a quick row and a toggle; the rest of its chips are only in
// the DOM once the toggle has opened the full list. `pick` hides that difference.
//
// Usage:
//   const { pick, chipOf } = require('./_picker.cjs')
//   await pick(modal.locator('[data-field="account_id"]'), 'Dlg Checking')
//   await pick(page, /^G Bank B$/)

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The chip whose accessible name starts with `name` (a string), or matches `name` (a RegExp). */
function chipOf(scope, name) {
  const re = name instanceof RegExp ? name : new RegExp(`^${escapeRe(name)}`)
  return scope.getByRole('button', { name: re })
}

/**
 * Clicks the chip named `name` inside `scope` (a picker group, or any locator or page that
 * holds one picker with that chip). When the chip is not rendered and a collapsed picker's
 * toggle is, the toggle is clicked first. Waits (bounded) for the chip or the toggle to
 * appear. Returns the chip's locator.
 */
async function pick(scope, name, { timeout = 10000 } = {}) {
  const chip = chipOf(scope, name)
  const toggle = scope.locator('[data-picker-toggle][aria-expanded="false"]')
  await chip.or(toggle).first().waitFor({ timeout })
  if ((await chip.count()) === 0) {
    if ((await toggle.count()) !== 1) throw new Error(`pick: no chip ${name} and ${await toggle.count()} collapsed toggles`)
    await toggle.click()
    await chip.first().waitFor({ timeout })
  }
  await chip.first().click()
  return chip.first()
}

module.exports = { pick, chipOf }
