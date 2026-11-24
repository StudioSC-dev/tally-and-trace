import { describe, it, expect } from 'vitest'
import { postingDateField } from './postingDate'

const NOW = new Date('2026-11-24T10:15:52.580Z')
const STORED = '2026-11-22T00:00:00Z'

describe('postingDateField', () => {
  it('stamps now on a create posted with no date', () => {
    expect(postingDateField(true, undefined, null, NOW)).toBe('2026-11-24T10:15:52.580Z')
  })

  it('sends a typed date on a create as UTC midnight', () => {
    expect(postingDateField(true, '2026-11-20', null, NOW)).toBe('2026-11-20T00:00:00.000Z')
  })

  it('leaves a create not posted without one', () => {
    expect(postingDateField(false, undefined, null, NOW)).toBeUndefined()
  })

  it('omits a blank date on an edit of a posted row that has none', () => {
    expect(postingDateField(true, undefined, { isPosted: true, postingDate: null }, NOW)).toBeUndefined()
    expect(postingDateField(true, undefined, { isPosted: true }, NOW)).toBeUndefined()
  })

  it('sends the same day on an edit of a posted row whose date is untouched', () => {
    expect(postingDateField(true, '2026-11-22', { isPosted: true, postingDate: STORED }, NOW)).toBe('2026-11-22T00:00:00.000Z')
  })

  it('clears the date on an edit of a posted row when the user empties it', () => {
    expect(postingDateField(true, undefined, { isPosted: true, postingDate: STORED }, NOW)).toBeNull()
  })

  it('stamps now on an edit that posts a pending row with the date cleared', () => {
    expect(postingDateField(true, undefined, { isPosted: false, postingDate: null }, NOW)).toBe('2026-11-24T10:15:52.580Z')
    expect(postingDateField(true, undefined, { isPosted: false, postingDate: STORED }, NOW)).toBe('2026-11-24T10:15:52.580Z')
  })

  it('sends a typed date on an edit as UTC midnight', () => {
    expect(postingDateField(true, '2026-11-23', { isPosted: true, postingDate: null }, NOW)).toBe('2026-11-23T00:00:00.000Z')
  })

  it('clears the stored date when an edit unposts the row', () => {
    expect(postingDateField(false, undefined, { isPosted: true, postingDate: STORED }, NOW)).toBeNull()
  })

  it('omits the date when an edit unposts a row that has none, or keeps a row pending', () => {
    expect(postingDateField(false, undefined, { isPosted: true, postingDate: null }, NOW)).toBeUndefined()
    expect(postingDateField(false, undefined, { isPosted: false, postingDate: STORED }, NOW)).toBeUndefined()
  })
})
