import { describe, expect, it, vi } from 'vitest'

// The components are plain functions, so the test calls them and reads the element tree.
vi.mock('react-native', () => {
  const host = (name: string) => name
  return {
    View: host('View'), Text: host('Text'), TouchableOpacity: host('TouchableOpacity'),
    ActivityIndicator: host('ActivityIndicator'), TextInput: host('TextInput'),
  }
})

import { AmountText } from './ui'

type Node = { type?: unknown; props?: { children?: unknown } } | string | number | boolean | null | undefined | Node[]

function textOf(node: Node): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children as Node)
}

const render = (props: { amount: number; currency: string }) =>
  textOf((AmountText as unknown as (p: typeof props) => Node)(props))

describe('AmountText', () => {
  it('amount_text_shows_currency', () => {
    // Symbol or code is shown, and the amount keeps its two-decimal, grouped, signed rendering.
    expect(render({ amount: 1234.5, currency: 'USD' })).toBe('$1,234.50')
    expect(render({ amount: -1234.5, currency: 'PHP' })).toBe('-₱1,234.50')
    expect(render({ amount: 5, currency: 'ZZZ' })).toBe('ZZZ 5.00')
  })
})
