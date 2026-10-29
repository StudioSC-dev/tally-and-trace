// Inline form errors (STU-410): one message per field key, shown under the field in place
// of a browser popup. The field carries aria-invalid and points at its message.

export type FieldErrors<K extends string> = Partial<Record<K, string>>

/** The field's ARIA props: invalid and described by its message while it has an error. */
export function fieldErrorProps<K extends string>(
  errors: FieldErrors<K>,
  key: K,
  errorId: string,
): { 'aria-invalid': true | undefined; 'aria-describedby': string | undefined } {
  const has = Boolean(errors[key])
  return { 'aria-invalid': has ? true : undefined, 'aria-describedby': has ? errorId : undefined }
}

/** The errors without `key` (cleared when the field is edited); the input is never mutated. */
export function withoutError<K extends string>(errors: FieldErrors<K>, key: K): FieldErrors<K> {
  if (!(key in errors)) return errors
  const next: FieldErrors<K> = { ...errors }
  delete next[key]
  return next
}
