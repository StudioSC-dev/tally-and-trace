import { describe, expect, it } from 'vitest'
import { fieldErrorProps, withoutError, type FieldErrors } from './fieldErrors'

type Key = 'name' | 'amount'

describe('fieldErrorProps', () => {
  it('marks the field invalid and points at its message while it has an error', () => {
    const errors: FieldErrors<Key> = { name: 'Enter a name' }
    expect(fieldErrorProps(errors, 'name', 'form-name-error')).toEqual({
      'aria-invalid': true,
      'aria-describedby': 'form-name-error',
    })
  })

  it('sets neither prop without an error, or with an empty message', () => {
    expect(fieldErrorProps<Key>({ name: 'Enter a name' }, 'amount', 'form-amount-error')).toEqual({
      'aria-invalid': undefined,
      'aria-describedby': undefined,
    })
    expect(fieldErrorProps<Key>({ amount: '' }, 'amount', 'form-amount-error')).toEqual({
      'aria-invalid': undefined,
      'aria-describedby': undefined,
    })
  })
})

describe('withoutError', () => {
  it('drops only the key and does not mutate its input', () => {
    const errors: FieldErrors<Key> = { name: 'Enter a name', amount: 'Enter an amount' }
    const next = withoutError(errors, 'name')
    expect(next).toEqual({ amount: 'Enter an amount' })
    expect(errors).toEqual({ name: 'Enter a name', amount: 'Enter an amount' })
    expect(next).not.toBe(errors)
  })

  it('returns the same errors when the key has none', () => {
    const errors: FieldErrors<Key> = { amount: 'Enter an amount' }
    expect(withoutError(errors, 'name')).toBe(errors)
    expect(errors).toEqual({ amount: 'Enter an amount' })
  })
})
