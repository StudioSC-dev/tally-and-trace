import { describe, it, expect } from 'vitest'
import { queryPhase, type QueryFlags } from './queryState'

const flags = (over: Partial<QueryFlags> = {}): QueryFlags => ({
  isError: false,
  isUninitialized: false,
  isFetching: false,
  ...over,
})

describe('queryPhase', () => {
  it('is skipped when the query is skipped, whatever the flags say', () => {
    expect(queryPhase(undefined, flags({ isUninitialized: true }), true)).toBe('skipped')
    expect(queryPhase([1], flags({ isError: true }), true)).toBe('skipped')
  })

  it('is error when the query failed, with and without data', () => {
    expect(queryPhase(undefined, flags({ isError: true }))).toBe('error')
    expect(queryPhase([1], flags({ isError: true }))).toBe('error')
  })

  it('is pending on the first render', () => {
    expect(queryPhase(undefined, flags({ isUninitialized: true }))).toBe('pending')
    expect(queryPhase(undefined, flags({ isFetching: true }))).toBe('pending')
  })

  it('is pending while fetching with no value', () => {
    expect(queryPhase(undefined, flags({ isFetching: true }))).toBe('pending')
  })

  it('is pending for an arg change whose currentData is undefined', () => {
    // data would still hold the old arg's rows; the caller passes currentData.
    expect(queryPhase(undefined, flags({ isFetching: true }))).toBe('pending')
  })

  it('is pending for a retry after an error (the error flag has cleared)', () => {
    expect(queryPhase(undefined, flags({ isFetching: true, isError: false }))).toBe('pending')
  })

  it('is ready with a value, fetching or not', () => {
    expect(queryPhase([], flags())).toBe('ready')
    expect(queryPhase({ a: 1 }, flags({ isFetching: true }))).toBe('ready')
    expect(queryPhase(null, flags())).toBe('ready')
    expect(queryPhase(0, flags())).toBe('ready')
  })
})
