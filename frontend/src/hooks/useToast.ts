import { createContext, useContext } from 'react'

/** Shows one message in the in-app toast; a newer message replaces the one shown. */
export type ShowToast = (message: string) => void

/** Provided by `ToastProvider` (components/Toast.tsx), mounted in Layout's signed-in branch. */
export const ToastContext = createContext<ShowToast | null>(null)

/** Outside the provider, showing throws. Rendering does not, as with `useConfirm`. */
const outsideProvider: ShowToast = () => {
  throw new Error('useToast must be used inside ToastProvider')
}

/**
 * The in-app toast (STU-410), for a message that has no dialog or form to show it in.
 * It stays until dismissed.
 */
export function useToast(): ShowToast {
  return useContext(ToastContext) ?? outsideProvider
}
