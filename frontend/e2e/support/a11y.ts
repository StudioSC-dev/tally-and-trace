import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { a11yExceptions } from './a11y-exceptions'

export interface A11yFinding {
  rule: string
  selector: string
}

/**
 * Runs an axe scan. Fails on any `critical` violation that is not in a11y-exceptions.ts.
 * `serious` violations are attached to the test as annotations and do not fail it.
 */
export async function a11y(page: Page): Promise<A11yFinding[]> {
  const { violations } = await new AxeBuilder({ page }).analyze()
  const critical: A11yFinding[] = []
  for (const violation of violations) {
    for (const node of violation.nodes) {
      const selector = node.target.join(' ')
      if (violation.impact === 'serious') {
        test.info().annotations.push({
          type: 'a11y-serious',
          description: `${violation.id} at ${selector}: ${violation.help}`,
        })
      }
      if (violation.impact === 'critical') {
        const excepted = a11yExceptions.some((e) => e.rule === violation.id && e.selector === selector)
        if (!excepted) critical.push({ rule: violation.id, selector })
      }
    }
  }
  expect(critical, 'critical a11y violations outside a11y-exceptions.ts').toEqual([])
  return critical
}
