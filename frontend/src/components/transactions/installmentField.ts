/** An Installment field that shows its error under it. */
export type InstallmentField = 'installment_total' | 'installment_months'

export const installmentErrorId = (key: InstallmentField) => `transaction-${key}-error`

/** The attributes an Installment field takes while it has an error (it is invalid, described by it). */
export const installmentErrorProps = (key: InstallmentField, message: string | undefined) =>
  (message ? { 'aria-invalid': true, 'aria-describedby': installmentErrorId(key) } : {})
