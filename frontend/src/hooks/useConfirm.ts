import { createContext, useContext } from 'react'
import type { ConfirmRequest } from '@tally-trace/shared'

/** Opens the in-app confirm dialog; resolves true once accepted (and its action succeeded), else false. */
export type AskConfirm = (req: ConfirmRequest) => Promise<boolean>

/** Provided by `ConfirmProvider` (components/ConfirmDialog.tsx), mounted in Layout's signed-in branch. */
export const ConfirmContext = createContext<AskConfirm | null>(null)

/** Outside the provider, asking throws. Rendering does not: a signed-in page still renders once while signed out, before its redirect. */
const outsideProvider: AskConfirm = () => {
  throw new Error('useConfirm must be used inside ConfirmProvider')
}

/**
 * The in-app replacement for the browser's confirm (STU-410). Call sites name it
 * `askConfirm`: `const askConfirm = useConfirm()`.
 */
export function useConfirm(): AskConfirm {
  return useContext(ConfirmContext) ?? outsideProvider
}
