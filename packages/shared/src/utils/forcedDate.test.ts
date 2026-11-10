import { describe, expect, it } from 'vitest'
import type { ForcedDateOptions } from '../types/api'
import { cascadeConfirmation, dateChoiceLines, effectiveDay, hasDateChoice, isForced, movedText, statementConfirmation } from './forcedDate'

describe('forced date text', () => {
  it('reads the scheduled day when nothing is forced', () => {
    expect(effectiveDay('2026-12-10')).toBe('2026-12-10')
    expect(isForced('2026-12-10', '2026-12-10')).toBe(false)
    expect(movedText('2026-12-10', '2026-12-10')).toBe(movedText('2026-12-10'))
    expect(movedText('2026-12-10')).not.toContain('moved')
  })

  it('names the day a forced occurrence moved from', () => {
    expect(isForced('2026-12-10', '2026-12-12')).toBe(true)
    expect(movedText('2026-12-10', '2026-12-12')).toBe('Dec 12th, 2026 (moved from Dec 10th, 2026)')
  })

  it('confirms the statement a card charge now falls on', () => {
    expect(statementConfirmation({ statement_close: '2026-12-12' })).toBe('Now on the statement closing Dec 12th, 2026')
    expect(statementConfirmation({ statement_close: null })).toBeNull()
    expect(statementConfirmation({})).toBeNull()
  })
})

const options = (patch: { overlap?: Partial<ForcedDateOptions['overlap']>; cascade?: Partial<ForcedDateOptions['cascade']> } = {}): ForcedDateOptions => ({
  overlap: {
    available: true,
    reason: null,
    date: '2026-10-10',
    payments: [
      { occurrence_date: '2026-09-10', effective_date: '2026-10-10', amount: '549.00' },
      { occurrence_date: '2026-10-10', effective_date: '2026-10-10', amount: '549.00' },
    ],
    total: '1098.00',
    currency: 'PHP',
    statement_close: null,
    ...patch.overlap,
  },
  cascade: {
    available: true,
    reason: null,
    rule: 'day_of_month',
    moves: [
      { occurrence_date: '2026-09-10', from: '2026-09-10', to: '2026-11-12', statement_close: null },
      { occurrence_date: '2026-10-10', from: '2026-10-10', to: '2026-12-12', statement_close: null },
      { occurrence_date: '2026-11-10', from: '2026-11-10', to: '2027-01-12', statement_close: null },
    ],
    remaining: null,
    ...patch.cascade,
  },
})

describe('dateChoiceLines', () => {
  it('lists the payments on the shared day and their total', () => {
    const { overlap } = dateChoiceLines(options())
    expect(overlap.title).toBe('Pay together on Oct 10th, 2026')
    expect(overlap.lines).toEqual([
      'Sep 10th, 2026 → Oct 10th, 2026 · ₱549.00',
      'Oct 10th, 2026 · ₱549.00',
    ])
    expect(overlap.total).toBe('Total on Oct 10th, 2026: ₱1,098.00')
    expect(overlap.note).toBeNull()
    expect(overlap.unavailable).toBeNull()
  })

  it('notes a chosen date past the next payment, and only then', () => {
    expect(dateChoiceLines(options(), '2026-11-12').overlap.note).toBe(
      'Nov 12th, 2026 is past the next payment; this is the closest day it can join it',
    )
    expect(dateChoiceLines(options(), '2026-10-10').overlap.note).toBeNull()
    expect(dateChoiceLines(options()).overlap.note).toBeNull()
  })

  it('lists the moves and a day-of-month repeat', () => {
    const { cascade } = dateChoiceLines(options())
    expect(cascade.lines).toEqual([
      'Sep 10th, 2026 → Nov 12th, 2026',
      'Oct 10th, 2026 → Dec 12th, 2026',
      'Nov 10th, 2026 → Jan 12th, 2027',
      '…and every later one on the 12th',
    ])
  })

  it('reads a day-count repeat from two moves, and gives none from one', () => {
    const weekly = options({
      cascade: {
        rule: 'days',
        moves: [
          { occurrence_date: '2026-09-10', from: '2026-09-10', to: '2026-11-12', statement_close: null },
          { occurrence_date: '2026-09-17', from: '2026-09-17', to: '2026-11-19', statement_close: null },
        ],
      },
    })
    expect(dateChoiceLines(weekly).cascade.lines.slice(-1)[0]).toBe('…and every later one every 7 days')
    const single = options({ cascade: { rule: 'days', moves: [weekly.cascade.moves[0]!] } })
    expect(dateChoiceLines(single).cascade.lines).toEqual(['Sep 10th, 2026 → Nov 12th, 2026'])
  })

  it('reads every 14 days from two moves a fortnight apart', () => {
    const biweekly = options({
      cascade: {
        rule: 'days',
        moves: [
          { occurrence_date: '2026-09-10', from: '2026-09-10', to: '2026-11-12', statement_close: null },
          { occurrence_date: '2026-09-24', from: '2026-09-24', to: '2026-11-26', statement_close: null },
        ],
      },
    })
    expect(dateChoiceLines(biweekly).cascade.lines.slice(-1)[0]).toBe('…and every later one every 14 days')
  })

  it('counts the payments that move on a bounded schedule', () => {
    expect(dateChoiceLines(options({ cascade: { remaining: 5 } })).cascade.lines.slice(-1)[0]).toBe('5 payments move in all')
    expect(dateChoiceLines(options({ cascade: { remaining: 1 } })).cascade.lines.slice(-1)[0]).toBe('1 payment moves in all')
  })

  it('adds the statement a card payment lands on', () => {
    const card = options({
      overlap: { statement_close: '2026-10-20' },
      cascade: {
        moves: [{ occurrence_date: '2026-09-10', from: '2026-09-10', to: '2026-11-12', statement_close: '2026-11-20' }],
      },
    })
    const lines = dateChoiceLines(card)
    expect(lines.overlap.lines[1]).toBe('Oct 10th, 2026 · ₱549.00 · statement closing Oct 20th, 2026')
    expect(lines.cascade.lines[0]).toBe('Sep 10th, 2026 → Nov 12th, 2026 · statement closing Nov 20th, 2026')
  })

  it('carries the server reason of an unavailable choice, and hides its lines', () => {
    const reason = 'only the oldest unpaid payment (Sep 10th, 2026) can delay the ones after it'
    const lines = dateChoiceLines(options({ cascade: { available: false, reason, rule: null, moves: [] } }))
    expect(lines.cascade.available).toBe(false)
    expect(lines.cascade.unavailable).toBe(`Delay all: ${reason}`)
    expect(lines.cascade.lines).toEqual([])
    expect(lines.overlap.unavailable).toBeNull()
  })

  it('offers a choice only when one is available', () => {
    expect(hasDateChoice(options())).toBe(true)
    expect(hasDateChoice(options({ overlap: { available: false, reason: 'x' } }))).toBe(true)
    expect(hasDateChoice(options({ overlap: { available: false, reason: 'x' }, cascade: { available: false, reason: 'y' } }))).toBe(false)
  })
})

describe('cascadeConfirmation', () => {
  it('names the new day and how later payments follow', () => {
    expect(cascadeConfirmation('2026-11-12', options().cascade)).toBe('Moved to Nov 12th, 2026. Later payments follow on the 12th.')
    const weekly = options({
      cascade: {
        rule: 'days',
        moves: [
          { occurrence_date: '2026-09-10', from: '2026-09-10', to: '2026-11-12', statement_close: null },
          { occurrence_date: '2026-09-24', from: '2026-09-24', to: '2026-11-26', statement_close: null },
        ],
      },
    })
    expect(cascadeConfirmation('2026-11-12', weekly.cascade)).toBe('Moved to Nov 12th, 2026. Later payments follow every 14 days.')
    expect(cascadeConfirmation('2026-11-12', { ...weekly.cascade, moves: weekly.cascade.moves.slice(0, 1) })).toBe('Moved to Nov 12th, 2026.')
  })
})
