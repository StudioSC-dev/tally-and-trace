import { describe, expect, it } from 'vitest'
import { finalMonthHelp, withLoadedVersion } from './entryEdit'

describe('withLoadedVersion', () => {
  it('sends the loaded updated_at string unchanged, microseconds included', () => {
    const loaded = { updated_at: '2026-10-01T02:03:04.123456+00:00' }
    const body = withLoadedVersion({ amount: 5 }, loaded)
    expect(body).toEqual({ amount: 5, expected_updated_at: '2026-10-01T02:03:04.123456+00:00' })
    expect(body.expected_updated_at).toBe(loaded.updated_at)
  })

  it('does not mutate the input', () => {
    const input = { amount: 5 }
    withLoadedVersion(input, { updated_at: '2026-10-01T00:00:00Z' })
    expect(input).toEqual({ amount: 5 })
  })

  it('sends null as null for an entry that was never updated', () => {
    const body = withLoadedVersion({ amount: 5 }, { updated_at: null })
    expect(body).toEqual({ amount: 5, expected_updated_at: null })
    expect('expected_updated_at' in body).toBe(true)
  })

  it('omits the field only when the entry has no updated_at property', () => {
    const body = withLoadedVersion({ amount: 5 }, {})
    expect(body).toEqual({ amount: 5 })
    expect('expected_updated_at' in body).toBe(false)
    expect('expected_updated_at' in withLoadedVersion({ amount: 5 }, { updated_at: undefined })).toBe(false)
  })

  it('replaces a stale version already on the body', () => {
    const body = withLoadedVersion({ expected_updated_at: 'old' }, { updated_at: 'new' })
    expect(body.expected_updated_at).toBe('new')
  })
})

describe('finalMonthHelp', () => {
  it('states the final-month rule', () => {
    expect(finalMonthHelp).toBe(
      'Moving the next date keeps the last payment; change this number to lengthen or shorten the plan.',
    )
  })
})
