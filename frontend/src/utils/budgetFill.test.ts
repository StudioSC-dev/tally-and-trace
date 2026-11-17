import { describe, expect, it } from 'vitest'
import { budgetFillClass } from './budgetFill'

describe('budgetFillClass', () => {
  it('is warn at exactly 80% when float math would round it down (800.16 of 1000.20)', () => {
    expect(budgetFillClass(800.16, 1000.2)).toBe('bg-warn')
  })

  it('is muted one centavo under 80% (800.15 of 1000.20)', () => {
    expect(budgetFillClass(800.15, 1000.2)).toBe('bg-muted')
  })

  it('is warn at exactly the limit (1000.20 of 1000.20)', () => {
    expect(budgetFillClass(1000.2, 1000.2)).toBe('bg-warn')
  })

  it('is danger one centavo over the limit (1000.21 of 1000.20)', () => {
    expect(budgetFillClass(1000.21, 1000.2)).toBe('bg-danger')
  })

  it('is warn at a whole-number 80% (4000 of 5000)', () => {
    expect(budgetFillClass(4000, 5000)).toBe('bg-warn')
  })
})
