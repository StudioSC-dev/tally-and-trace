import { describe, it, expect } from 'vitest'
import type { InstallmentBlockReason, InstallmentReview } from '../types/api'
import { autoPostLabel, envelopeNote, linkChoices, reviewBody, reviewButtonText } from './installmentReview'

function review(over: Partial<InstallmentReview> = {}): InstallmentReview {
  return {
    entry_id: 7,
    name: 'Tablet',
    account_name: 'Visa',
    currency: 'PHP',
    amount: 2000,
    reviewed: false,
    auto_post_enabled: false,
    block: null,
    missed: [
      { occurrence_date: '2026-08-05', linked: null },
      { occurrence_date: '2026-09-05', linked: 'pending' },
    ],
    candidates: [
      {
        occurrence_date: '2026-08-05',
        transactions: [
          { id: 11, date: '2026-08-06', amount: 2000, is_posted: true, description: 'Tablet' },
          { id: 12, date: '2026-09-05', amount: 2000, is_posted: true, description: null },
        ],
      },
      {
        occurrence_date: '2026-09-05',
        transactions: [{ id: 12, date: '2026-09-05', amount: 2000, is_posted: true, description: null }],
      },
    ],
    remaining_after: 4,
    envelope: null,
    past_cycles: false,
    entry_version: '2026-10-01T02:03:04.123456Z',
    review_token: 'tok',
    ...over,
  }
}

describe('autoPostLabel', () => {
  it('words each state', () => {
    expect(autoPostLabel('unreviewed', true, null)).toBe('Review to auto-post')
    expect(autoPostLabel('held', true, null)).toBe('Possible duplicate · Review')
    expect(autoPostLabel('off', false, null)).toBe('Auto-post off · Mark paid')
  })
  it('reads on by whether the daily job is set up', () => {
    expect(autoPostLabel('on', true, null)).toBe('Auto-posts each morning')
    expect(autoPostLabel('on', false, null)).toBe('Auto-posts when you open Transactions')
  })
  it('words each blocked reason', () => {
    const text = (r: InstallmentBlockReason) => autoPostLabel('blocked', false, r)
    expect(text('foreign_currency')).toBe("Doesn't auto-post: another currency · Mark paid with the amount charged")
    expect(text('no_statement_cycle')).toBe("Doesn't auto-post: the card has no statement cycle · Mark paid")
    expect(text('creator_no_access')).toBe("Doesn't auto-post: its creator can no longer edit this card")
    expect(text('ambiguous')).toBe(
      "Doesn't auto-post: a month has more than one linked transaction · resolve them on the Transactions page",
    )
  })
  it('is null with no state', () => {
    expect(autoPostLabel(null, true, null)).toBeNull()
  })
})

describe('linkChoices', () => {
  it('lists each month with its candidates, none selected', () => {
    const out = linkChoices(review(), {})
    expect(out.map((m) => m.occurrenceDate)).toEqual(['2026-08-05', '2026-09-05'])
    expect(out[0]?.options.map((o) => [o.transaction.id, o.selected, o.disabled])).toEqual([
      [11, false, false],
      [12, false, false],
    ])
  })
  it('lets a transaction offered under two months be chosen once', () => {
    const out = linkChoices(review(), { '2026-08-05': 12 })
    expect(out[0]?.options.find((o) => o.transaction.id === 12)).toMatchObject({ selected: true, disabled: false })
    expect(out[1]?.options.find((o) => o.transaction.id === 12)).toMatchObject({ selected: false, disabled: true })
  })
})

describe('reviewBody', () => {
  it('carries the binding fields unchanged and the chosen links', () => {
    expect(reviewBody(review(), { '2026-08-05': 11 })).toEqual({
      entry_version: '2026-10-01T02:03:04.123456Z',
      review_token: 'tok',
      links: [{ transaction_id: 11, occurrence_date: '2026-08-05' }],
    })
  })
  it('sends a null version as null and no links by default', () => {
    expect(reviewBody(review({ entry_version: null }))).toEqual({ entry_version: null, review_token: 'tok', links: [] })
  })
  it('drops a link that is not a candidate for its month, and a transaction chosen twice', () => {
    const body = reviewBody(review(), { '2026-08-05': 99, '2026-09-05': 12 })
    expect(body.links).toEqual([{ transaction_id: 12, occurrence_date: '2026-09-05' }])
    const twice = reviewBody(review(), { '2026-08-05': 12, '2026-09-05': 12 })
    expect(twice.links).toEqual([{ transaction_id: 12, occurrence_date: '2026-08-05' }])
  })
})

describe('reviewButtonText', () => {
  it('names the months it records', () => {
    expect(reviewButtonText(review())).toBe('Record 2 months and turn on auto-post')
    expect(reviewButtonText(review({ missed: [{ occurrence_date: '2026-08-05', linked: null }] }))).toBe(
      'Record 1 month and turn on auto-post',
    )
  })
  it('only turns auto-post on when nothing is missed', () => {
    expect(reviewButtonText(review({ missed: [] }))).toBe('Turn on auto-post')
  })
})

describe('envelopeNote', () => {
  it('names the envelope when the server sent it', () => {
    expect(envelopeNote(review({ envelope: { allocation_name: 'Gadgets' } }))).toBe(
      "Recording past months changes Gadgets's figures for those periods",
    )
  })
  it('is generic when it is null', () => {
    expect(envelopeNote(review())).toBe('Recording past months can change budget figures for those periods')
  })
})
