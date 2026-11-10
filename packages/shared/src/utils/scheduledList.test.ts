import { describe, it, expect } from 'vitest'
import { scheduledPageText, scheduledRange, scheduledThroughNote } from './scheduledList'

const TODAY = '2026-11-10'

describe('scheduledRange', () => {
  it('starts on Manila tomorrow and runs through today + 365 by default', () => {
    const range = scheduledRange(TODAY)
    expect(range.start).toBe('2026-11-11')
    expect(range.end).toBe('2027-11-10')
    expect(range.occurrencesThrough).toBe('2027-11-10')
    expect(range.listedThrough).toBeNull()
    expect(scheduledThroughNote(range)).toBeNull()
  })

  it('takes a later From and never one on or before today', () => {
    expect(scheduledRange(TODAY, '2026-12-01').start).toBe('2026-12-01')
    expect(scheduledRange(TODAY, '2026-11-10').start).toBe('2026-11-11')
    expect(scheduledRange(TODAY, '2020-01-01').start).toBe('2026-11-11')
    expect(scheduledRange(TODAY, '').start).toBe('2026-11-11')
  })

  it('stops recurring payments at today + 730 and says so when Through passes it', () => {
    const range = scheduledRange(TODAY, undefined, '2030-01-01')
    expect(range.end).toBe('2030-01-01')
    expect(range.occurrencesThrough).toBe('2028-11-09')
    expect(range.listedThrough).toBe('2028-11-09')
    expect(scheduledThroughNote(range)).toBe(
      'Recurring payments are listed through Nov 9th, 2028; one-off transactions continue after it',
    )
  })

  it('has no note when Through is exactly today + 730', () => {
    const range = scheduledRange(TODAY, undefined, '2028-11-09')
    expect(range.listedThrough).toBeNull()
    expect(range.occurrencesThrough).toBe('2028-11-09')
  })

  it('stops Through at the record maximum (today + 5 years) and keeps Through at or after From', () => {
    expect(scheduledRange(TODAY, undefined, '2040-01-01').end).toBe('2031-11-10')
    expect(scheduledRange(TODAY, '2027-03-01', '2027-01-01').end).toBe('2027-03-01')
    expect(scheduledRange(TODAY).max).toBe('2031-11-10')
    expect(scheduledRange(TODAY).min).toBe('2026-11-11')
  })
})

describe('scheduledPageText', () => {
  it('reads the rows of the page out of the total', () => {
    expect(scheduledPageText(0, 25, 25, 60)).toBe('Showing 1–25 of 60')
    expect(scheduledPageText(1, 25, 25, 60)).toBe('Showing 26–50 of 60')
    expect(scheduledPageText(2, 25, 10, 60)).toBe('Showing 51–60 of 60')
    expect(scheduledPageText(0, 25, 0, 0)).toBeNull()
  })
})
