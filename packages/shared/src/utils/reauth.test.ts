import { describe, it, expect } from 'vitest'
import { stepAfter401 } from './reauth'

describe('stepAfter401', () => {
  it('refreshes a 401 on a request sent with a token in the same session', () => {
    expect(stepAfter401({ sentToken: true, startedGeneration: 3, currentGeneration: 3 })).toBe(
      'refresh',
    )
  })

  it('clears, never refreshes, a 401 on a request sent with no token (STU-428)', () => {
    const step = stepAfter401({ sentToken: false, startedGeneration: 4, currentGeneration: 4 })
    expect(step).toBe('clear')
    expect(step).not.toBe('refresh')
  })

  it('ignores a 401 from an older session, with or without a token (STU-239)', () => {
    expect(stepAfter401({ sentToken: true, startedGeneration: 2, currentGeneration: 3 })).toBe(
      'ignore',
    )
    expect(stepAfter401({ sentToken: false, startedGeneration: 2, currentGeneration: 3 })).toBe(
      'ignore',
    )
  })

  it('ignores a request that started in a later session than the current one', () => {
    expect(stepAfter401({ sentToken: true, startedGeneration: 5, currentGeneration: 3 })).toBe(
      'ignore',
    )
  })
})
