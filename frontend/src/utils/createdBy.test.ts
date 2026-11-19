import { describe, expect, it } from 'vitest'
import { chunkFacts, createdByLabel, isSharedAccount, viewerDisplayName } from './createdBy'

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
})

describe('isSharedAccount', () => {
  it('is shared when the owner shares it out or someone else owns it', () => {
    expect(isSharedAccount({ is_shared: false, my_role: 'owner' })).toBe(false)
    expect(isSharedAccount({ is_shared: true, my_role: 'owner' })).toBe(true)
    expect(isSharedAccount({ is_shared: null, my_role: 'editor' })).toBe(true)
    expect(isSharedAccount(undefined)).toBe(false)
  })
})

describe('chunkFacts', () => {
  it('drops empty facts and lines at most three', () => {
    expect(chunkFacts(['a', false, 'b', null, 'c', 'd', undefined, ''])).toEqual([['a', 'b', 'c'], ['d']])
    expect(chunkFacts([])).toEqual([])
  })
})
