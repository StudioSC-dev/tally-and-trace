import { describe, it, expect } from 'vitest'
import { upcomingWindow } from './transactionList'

// Runs in its own vitest process under TZ=America/Los_Angeles (the `test:la` script).
describe('upcomingWindow across a DST change in Los Angeles', () => {
  it('runs in a zone whose offset changes between the 8th and 9th of March 2026', () => {
    expect(new Date(2026, 2, 8).getTimezoneOffset()).not.toBe(new Date(2026, 2, 9).getTimezoneOffset())
  })

  it('ends 30 calendar days on over the spring-forward night', () => {
    expect(upcomingWindow('2026-03-01')).toEqual({
      start: '2026-03-02T00:00:00Z',
      end: '2026-03-31T23:59:59.999999Z',
      through: '2026-03-31',
    })
  })

  it('ends 30 calendar days on over the fall-back night', () => {
    expect(upcomingWindow('2026-10-20')).toEqual({
      start: '2026-10-21T00:00:00Z',
      end: '2026-11-19T23:59:59.999999Z',
      through: '2026-11-19',
    })
  })
})
