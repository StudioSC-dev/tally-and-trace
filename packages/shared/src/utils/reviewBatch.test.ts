import { describe, expect, it } from 'vitest'
import type { InstallmentReviewRow, ReviewInstallmentsResult } from '../types/api'
import { dueReviewNotice } from './dueSection'
import {
  BATCH_LIMIT,
  CAP_REASON,
  atCap,
  batchConfirmMessage,
  batchSummary,
  cleanIds,
  effectiveSelection,
  reviewBatchItems,
  reviewSelectedText,
  selectAll,
  selectAllState,
  toggleSelection,
} from './reviewBatch'

function row(id: number, clean: boolean, version: string | null = '2026-10-17T03:04:05.123456+00:00'): InstallmentReviewRow {
  return {
    entry_id: id,
    name: `Plan ${id}`,
    account_name: 'Visa',
    missed_count: clean ? 0 : 1,
    clean_review: clean ? { entry_version: version, review_token: `tok-${id}` } : null,
  }
}
const snap = (rows: InstallmentReviewRow[]) => ({ installment_review: rows })
const notice = (rows: InstallmentReviewRow[]) => dueReviewNotice(snap(rows))
/** Clean rows with ids 1..n, given out of order. */
function cleanRows(n: number): InstallmentReviewRow[] {
  const ids = Array.from({ length: n }, (_, i) => i + 1)
  return [...ids.slice(n / 2), ...ids.slice(0, n / 2)].map((id) => row(id, true))
}

describe('BATCH_LIMIT', () => {
  it('matches the server cap', () => {
    expect(BATCH_LIMIT).toBe(50)
    expect(CAP_REASON).toBe('Up to 50 at a time; review the rest after these')
  })
})

describe('reviewBatchItems', () => {
  it('drops ids that are not clean or not present, and sorts by id', () => {
    const s = snap([row(9, true), row(3, false), row(5, true), row(2, true)])
    const items = reviewBatchItems(s, new Set([9, 3, 5, 77]))
    expect(items.map((i) => i.entry_id)).toEqual([5, 9])
    expect(items[0]).toEqual({ entry_id: 5, entry_version: '2026-10-17T03:04:05.123456+00:00', review_token: 'tok-5' })
  })
  it('echoes entry_version byte for byte, including null', () => {
    const odd = '2026-10-17T03:04:05.100000+00:00'
    const items = reviewBatchItems(snap([row(1, true, odd), row(2, true, null)]), new Set([1, 2]))
    expect(items[0]?.entry_version).toBe(odd)
    expect(items[1]?.entry_version).toBeNull()
  })
  it('never returns more than 50, with no duplicate', () => {
    const rows = cleanRows(51)
    const items = reviewBatchItems(snap(rows), new Set(rows.map((r) => r.entry_id)))
    expect(items).toHaveLength(50)
    expect(new Set(items.map((i) => i.entry_id)).size).toBe(50)
    expect(items.map((i) => i.entry_id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
  it('is empty with nothing selected', () => {
    expect(reviewBatchItems(snap([row(1, true)]), new Set())).toEqual([])
  })
})

describe('selection', () => {
  it('cleanIds lists clean ids ascending', () => {
    expect(cleanIds(notice([row(4, true), row(2, false), row(1, true)]))).toEqual([1, 4])
    expect(cleanIds(null)).toEqual([])
  })
  it('effectiveSelection drops an id that is no longer clean after a refetch', () => {
    const before = notice([row(1, true), row(2, true)])
    const picked = selectAll(before)
    expect([...picked]).toEqual([1, 2])
    const after = notice([row(1, true), row(2, false)])
    expect([...effectiveSelection(picked, after)]).toEqual([1])
    expect([...effectiveSelection(picked, null)]).toEqual([])
  })
  it('toggleSelection ticks, unticks and refuses an id that is not clean', () => {
    const n = notice([row(1, true), row(2, false)])
    const one = toggleSelection(new Set(), 1, n)
    expect([...one]).toEqual([1])
    expect([...toggleSelection(one, 1, n)]).toEqual([])
    const same = new Set<number>()
    expect(toggleSelection(same, 2, n)).toBe(same)
    expect(toggleSelection(same, 99, n)).toBe(same)
  })
  it('selectAllState covers none, some, all and disabled', () => {
    const n = notice([row(1, true), row(2, true), row(3, false)])
    expect(selectAllState(new Set(), n)).toBe('none')
    expect(selectAllState(new Set([1]), n)).toBe('some')
    expect(selectAllState(new Set([1, 2]), n)).toBe('all')
    expect(selectAllState(new Set([3]), n)).toBe('none')
    expect(selectAllState(new Set(), notice([row(3, false)]))).toBe('disabled')
    expect(selectAllState(new Set(), null)).toBe('disabled')
  })
})

describe('the cap', () => {
  it('with 51 clean rows, Select all takes ids 1 to 50 and reads all', () => {
    const n = notice(cleanRows(51))
    const picked = selectAll(n)
    expect([...picked].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(selectAllState(picked, n)).toBe('all')
    expect(atCap(picked, n)).toBe(true)
    expect(toggleSelection(picked, 51, n)).toBe(picked)
    const freed = toggleSelection(picked, 7, n)
    expect(freed.size).toBe(49)
    expect(atCap(freed, n)).toBe(false)
    const swapped = toggleSelection(freed, 51, n)
    expect(swapped.size).toBe(50)
    expect(swapped.has(51)).toBe(true)
    expect(swapped.has(7)).toBe(false)
    const items = reviewBatchItems(snap(cleanRows(51)), picked)
    expect(items).toHaveLength(50)
    expect(new Set(items.map((i) => i.entry_id)).size).toBe(50)
  })
  it('with 50 clean rows the cap is reached and Select all takes all of them', () => {
    const n = notice(cleanRows(50))
    const picked = selectAll(n)
    expect(picked.size).toBe(50)
    expect(atCap(picked, n)).toBe(true)
    expect(selectAllState(picked, n)).toBe('all')
  })
  it('with 49 clean rows the cap is not reached', () => {
    const rows = Array.from({ length: 49 }, (_, i) => row(i + 1, true))
    const n = notice(rows)
    const picked = selectAll(n)
    expect(picked.size).toBe(49)
    expect(atCap(picked, n)).toBe(false)
  })
})

describe('text', () => {
  it('words the button and the confirm by count', () => {
    expect(reviewSelectedText(0)).toBe('Review selected (0)')
    expect(reviewSelectedText(3)).toBe('Review selected (3)')
    expect(batchConfirmMessage(1)).toBe('1 installment will start auto-posting.')
    expect(batchConfirmMessage(3)).toBe('3 installments will start auto-posting.')
  })
})

describe('batchSummary', () => {
  const names = new Map([
    [1, 'Tablet'],
    [2, 'Phone'],
    [3, 'Laptop'],
    [4, 'Watch'],
    [5, 'Camera'],
    [6, 'Desk'],
  ])
  it('maps all seven outcomes', () => {
    const result: ReviewInstallmentsResult = {
      reviewed: 2,
      results: [
        { entry_id: 1, outcome: 'reviewed', detail: null },
        { entry_id: 2, outcome: 'replayed', detail: null },
        { entry_id: 3, outcome: 'changed', detail: 'This installment changed' },
        { entry_id: 4, outcome: 'needs_choices', detail: 'Review it on its own' },
        { entry_id: 5, outcome: 'blocked', detail: 'This entry is paused' },
        { entry_id: 6, outcome: 'not_found', detail: 'Budget entry not found' },
        { entry_id: 7, outcome: 'failed', detail: 'more than one linked transaction' },
      ],
    }
    const s = batchSummary(result, names)
    expect(s.text).toBe('Auto-post is on for 2 installments')
    expect(s.failures.map((f) => [f.entryId, f.text])).toEqual([
      [3, 'Laptop: changed since the list loaded; select it again or use Review'],
      [4, 'Watch: Review it on its own'],
      [5, 'Camera: This entry is paused'],
      [6, 'Desk: you can no longer review it'],
      [7, 'Installment 7: more than one linked transaction'],
    ])
    expect(s.failures.map((f) => f.name)).toEqual(['Laptop', 'Watch', 'Camera', 'Desk', 'Installment 7'])
  })
  it('uses the click-time names even when the row is gone, and says one installment in the singular', () => {
    const s = batchSummary({ reviewed: 1, results: [{ entry_id: 1, outcome: 'reviewed', detail: null }] }, new Map())
    expect(s.text).toBe('Auto-post is on for 1 installment')
    expect(s.failures).toEqual([])
  })
  it('gives a null text when nothing was reviewed', () => {
    const s = batchSummary({ reviewed: 0, results: [{ entry_id: 3, outcome: 'changed', detail: null }] }, names)
    expect(s.text).toBeNull()
    expect(s.failures).toHaveLength(1)
  })
  it('falls back when a failure has no detail', () => {
    const s = batchSummary({ reviewed: 0, results: [{ entry_id: 3, outcome: 'failed', detail: null }] }, names)
    expect(s.failures[0]?.text).toBe('Laptop: could not be reviewed')
  })
})
