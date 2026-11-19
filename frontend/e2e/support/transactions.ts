import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Expands the Transactions page's Due card (STU-687: it opens collapsed, as a one-line banner with no tabs) and waits
 * for its tabs. Does nothing when the card is already expanded.
 */
export async function expandDue(page: Page): Promise<void> {
  const toggle = page.getByTestId('due-section-toggle')
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
    // The pointer leaves the toggle, so no measurement afterwards sees its hover fill.
    await page.mouse.move(0, 0)
    // The secondary button's hover fill fades out; it is clear again at rest.
    await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('due-tabs')).toBeVisible()
}

/** Opens the Transactions page's Filters disclosure (STU-687: the filters and the Date range line live in it). */
export async function openTransactionFilters(page: Page): Promise<void> {
  const toggle = page.getByTestId('transactions-filters-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
    await page.mouse.move(0, 0)
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('transactions-filters')).toBeVisible()
}
