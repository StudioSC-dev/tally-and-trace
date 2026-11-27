// The budget envelope endpoints (STU-795) against a stubbed fetch: the request each one
// sends and the body it hands back, typed with the shared API contract.
import { configureStore } from '@reduxjs/toolkit'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { BudgetPeriod, BudgetTransactionPage } from '@tally-trace/shared'

vi.stubEnv('VITE_API_URL', 'http://api.test')
vi.stubGlobal('localStorage', { getItem: () => 'token', setItem: () => undefined, removeItem: () => undefined })

const periods: BudgetPeriod[] = [{
  start: '2026-02-01T00:00:00Z', end: '2026-03-01T00:00:00Z', limit: 1000, carry_in: 900, available: 1900,
  spent: 40, remaining: 1860, complete: true, missing: [], provisional: true, inherited_missing: ['EUR'],
  estimated: false, before_created: false, is_current: true,
}]

const page: BudgetTransactionPage = {
  items: [{
    view: 'limited', id: 7, permissions: { can_edit: false, can_delete: false, can_post: false, can_revert: false, can_tag: true },
    created_by: 'Share P.', date: '2026-02-03T00:00:00Z', display_description: 'Expense', amount: 40, transfer_fee: null,
    currency: 'PHP', transaction_type: 'debit', is_posted: true, category_name: null,
    account: { id: null, name: 'Other account' }, counterpart: null, tags: [],
  }],
  total: 1, has_more: false, currency_subtotals: { PHP: 40 }, converted_total: 40,
}

const sent: Request[] = []
const last = (): Request => sent[sent.length - 1]
vi.stubGlobal('fetch', async (request: Request) => {
  sent.push(request)
  const body = new URL(request.url).pathname.endsWith('/periods') ? periods : page
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
})

const { accountingApi } = await import('./api')

const store = configureStore({
  reducer: { [accountingApi.reducerPath]: accountingApi.reducer },
  middleware: (getDefault) => getDefault().concat(accountingApi.middleware),
})

describe('budget envelope endpoints (STU-795)', () => {
  it('budget period and transaction endpoints use the shared API contract', async () => {
    const history = await store.dispatch(accountingApi.endpoints.getBudgetPeriods.initiate(12))
    expectTypeOf(history.data).toEqualTypeOf<BudgetPeriod[] | undefined>()
    expect(history.data).toEqual(periods)
    expect(last().method).toBe('GET')
    expect(last().url).toBe('http://api.test/api/v1/allocations/12/periods')

    const rows = await store.dispatch(accountingApi.endpoints.getBudgetTransactions.initiate({
      id: 12, period_start: periods[0].start, limit: 25, offset: 50,
    }))
    expectTypeOf(rows.data).toEqualTypeOf<BudgetTransactionPage | undefined>()
    expect(rows.data).toEqual(page)
    const url = new URL(last().url)
    expect(url.pathname).toBe('/api/v1/allocations/12/transactions')
    // The window's start is sent verbatim, as /periods returned it.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      period_start: '2026-02-01T00:00:00Z', limit: '25', offset: '50',
    })

    await store.dispatch(accountingApi.endpoints.getBudgetTransactions.initiate({ id: 12 }))
    expect(new URL(last().url).search).toBe('')  // the current window
    expect(sent.every((r) => r.headers.get('authorization') === 'Bearer token')).toBe(true)
  })
})
