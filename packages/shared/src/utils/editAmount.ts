// A loan payment stores its principal as the amount and its interest as the fee;
// the whole payment is principal + interest, rounded to whole cents.
// Rounding is done by scaling to cents and rounding half up (Math.round), so
// toTotal(0.1, 0.2) is 0.3 rather than 0.30000000000000004. A null or undefined
// interest counts as zero.
export const toTotal = (principal: number, interest?: number | null): number =>
  Math.round((principal + (interest ?? 0)) * 100) / 100

export interface EditAmountSource {
  projected_amount?: number | null
  projected_currency?: string | null
  currency?: string | null
  amount: number
  transfer_fee?: number | null
  is_posted: boolean
}

// The projected amount an edit form starts with.
//  1. A stored projected amount wins (0 stays 0).
//  2. A loan payment falls back to its whole payment (principal + interest).
//  3. A posted row has no projected amount to show: undefined.
//  4. An unposted row falls back to its amount, the same face the backend reports,
//     but only when the projected currency is absent or equals the row currency;
//     a mismatched currency cannot be read from the amount, so undefined.
export function editFormProjectedAmount(
  source: EditAmountSource,
  intoLoan: boolean,
): number | undefined {
  if (source.projected_amount !== null && source.projected_amount !== undefined) {
    return source.projected_amount
  }
  if (intoLoan) {
    return toTotal(source.amount, source.transfer_fee)
  }
  if (source.is_posted) {
    return undefined
  }
  const projectedCurrency = source.projected_currency
  if (projectedCurrency === null || projectedCurrency === undefined || projectedCurrency === source.currency) {
    return source.amount
  }
  return undefined
}
