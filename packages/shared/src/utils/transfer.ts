export interface TransferAccountFields {
  transfer_from_account_id: number | null | undefined
  transfer_to_account_id: number | null | undefined
}

/**
 * The transfer account fields a transaction write carries. A transfer keeps its
 * source and destination; any other type sends both as explicit nulls, so an
 * edit away from a transfer clears the stored accounts instead of leaving them.
 */
export function transferAccountFields(
  transactionType: string,
  from: number | null | undefined,
  to: number | null | undefined,
): TransferAccountFields {
  if (transactionType === 'transfer') {
    return { transfer_from_account_id: from, transfer_to_account_id: to }
  }
  return { transfer_from_account_id: null, transfer_to_account_id: null }
}
