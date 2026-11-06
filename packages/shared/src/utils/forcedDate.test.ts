import { describe, expect, it } from 'vitest'
import { effectiveDay, isForced, movedText, statementConfirmation } from './forcedDate'

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
