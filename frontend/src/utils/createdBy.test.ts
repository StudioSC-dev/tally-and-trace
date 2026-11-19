import { describe, expect, it } from 'vitest'
import { createdByLabel, foldFacts, isSharedAccount, viewerDisplayName } from './createdBy'

describe('viewerDisplayName', () => {
  it('reads like the API names a creator', () => {
    expect(viewerDisplayName({ first_name: 'Mara', last_name: 'Santos' })).toBe('Mara S.')
    expect(viewerDisplayName({ first_name: 'Mara', last_name: '' })).toBe('Mara')
    expect(viewerDisplayName(null)).toBeNull()
  })
})

describe('createdByLabel', () => {
  it('names the creator when they are not the viewer or the account is shared', () => {
    expect(createdByLabel('Mara S.', 'Mara S.', false)).toBeNull()
    expect(createdByLabel('Mara S.', 'Mara S.', true)).toBe('by Mara S.')
    expect(createdByLabel('Jun R.', 'Mara S.', false)).toBe('by Jun R.')
    expect(createdByLabel('Jun R.', 'Mara S.', true)).toBe('by Jun R.')
    expect(createdByLabel(null, 'Mara S.', true)).toBeNull()
  })
  it('shows nothing until the viewer is known', () => {
    expect(createdByLabel('Jun R.', null, true)).toBeNull()
    expect(createdByLabel('Mara S.', null, false)).toBeNull()
  })
})

describe('isSharedAccount', () => {
  it('follows the shared package rule', () => {
    expect(isSharedAccount({ is_shared: false, my_role: 'owner' })).toBe(false)
    expect(isSharedAccount({ is_shared: null, my_role: 'owner' })).toBe(false)
    expect(isSharedAccount({ is_shared: true, my_role: 'owner' })).toBe(true)
    expect(isSharedAccount({ is_shared: null, my_role: 'editor' })).toBe(true)
    expect(isSharedAccount(undefined)).toBe(false)
  })
})

describe('foldFacts', () => {
  it('drops empty facts and keeps at most three items', () => {
    expect(foldFacts(['a', false, 'b', null, 'c'])).toEqual(['a', 'b', 'c'])
    expect(foldFacts([])).toEqual([])
    const folded = foldFacts(['a', 'b', 'c', 'd', 'e'])
    expect(folded).toHaveLength(3)
    expect(folded.slice(0, 2)).toEqual(['a', 'b'])
  })
})
