import { describe, it, expect } from 'vitest'
import { loggedDays } from './dueSection'

// Runs in its own vitest process under TZ=America/Los_Angeles (the `test:la` script).
describe('loggedDays across a DST change in Los Angeles', () => {
  it('runs in a zone whose offset changes between the 8th and 9th of March 2026', () => {
    expect(new Date(2026, 2, 8).getTimezoneOffset()).not.toBe(new Date(2026, 2, 9).getTimezoneOffset())
  })

  it('counts one day over the spring-forward night', () => {
    expect(loggedDays('2026-03-08', '2026-03-09')).toBe(1)
    expect(Number.isInteger(loggedDays('2026-03-08', '2026-03-09'))).toBe(true)
  })

  it('counts two days from the 7th to the 9th of March', () => {
    expect(loggedDays('2026-03-07', '2026-03-09')).toBe(2)
    expect(Number.isInteger(loggedDays('2026-03-07', '2026-03-09'))).toBe(true)
  })

  it('counts one day over the fall-back night', () => {
    expect(loggedDays('2026-11-01', '2026-11-02')).toBe(1)
    expect(Number.isInteger(loggedDays('2026-11-01', '2026-11-02'))).toBe(true)
  })
})
