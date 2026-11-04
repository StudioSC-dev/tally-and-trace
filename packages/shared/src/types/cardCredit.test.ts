import { describe, it, expect } from 'vitest'
import type { CardCreditDetail, StatementDueInput } from '../index'

// A GET /cards/{id}/credit body in the shape routers/cards.py builds it, with
// one statement's due entered from the statement. `satisfies` makes the
// typecheck fail on any key the type lacks or misnames.
const detail = {
  account_id: 3,
  name: 'Card A',
  currency: 'PHP',
  credit: null,
  rule: null,
  statements: [
    {
      close_date: '2026-11-04', due_date: '2026-12-02', due_overridden: true,
      computed_due_date: '2026-12-01', status: 'open', owed: 20000, clear_through: 20000,
      outstanding: 20000, incomplete: false,
      minimum_due: {
        amount: null, remaining: null, source: 'unavailable', reason: 'no_rule',
        complete: false, assumptions: [], inputs: null,
      },
      unposted_installments: 0, unposted_postable: 0,
    },
  ],
  open_cycle: {
    close_date: '2026-12-04', due_date: '2026-12-29', due_overridden: false,
    computed_due_date: '2026-12-29',
  },
  unposted: null,
} satisfies CardCreditDetail

const input = { due_date: '2026-12-02' } satisfies StatementDueInput

describe('statement due override types', () => {
  it('carries the printed and the computed due', () => {
    const [statement] = detail.statements
    expect([statement.due_date, statement.computed_due_date, statement.due_overridden])
      .toEqual(['2026-12-02', '2026-12-01', true])
    expect(detail.open_cycle.due_overridden).toBe(false)
    expect(input.due_date).toBe(statement.due_date)
  })
})
