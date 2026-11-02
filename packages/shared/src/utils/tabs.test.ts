import { describe, it, expect } from 'vitest'
import { tabKeyTarget } from './tabs'

describe('tabKeyTarget', () => {
  it('moves right and left, wrapping at both ends', () => {
    expect(tabKeyTarget('ArrowRight', 0, 2)).toBe(1)
    expect(tabKeyTarget('ArrowRight', 1, 2)).toBe(0)
    expect(tabKeyTarget('ArrowLeft', 1, 2)).toBe(0)
    expect(tabKeyTarget('ArrowLeft', 0, 2)).toBe(1)
    expect(tabKeyTarget('ArrowRight', 2, 4)).toBe(3)
    expect(tabKeyTarget('ArrowLeft', 0, 4)).toBe(3)
  })

  it('jumps to the first and last tab', () => {
    expect(tabKeyTarget('Home', 1, 3)).toBe(0)
    expect(tabKeyTarget('End', 0, 3)).toBe(2)
  })

  it('ignores any other key', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(tabKeyTarget(key, 0, 2)).toBeNull()
  })

  it('stays on the only tab', () => {
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) expect(tabKeyTarget(key, 0, 1)).toBe(0)
  })

  it('gives null when there is no tab', () => {
    expect(tabKeyTarget('ArrowRight', 0, 0)).toBeNull()
  })
})
