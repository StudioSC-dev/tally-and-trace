/** The API's reason for a refused request (a string or a validation list), or ''. */
export const apiErrorMessage = (error: unknown): string => {
  const detail = (error as { data?: { detail?: unknown } } | undefined)?.data?.detail
  return typeof detail === 'string'
    ? detail
    : Array.isArray(detail)
      ? detail.map((item) => (item as { msg?: string })?.msg).filter(Boolean).join('; ')
      : ''
}

/** The HTTP status of a failed RTK Query call, or undefined (network error, no response). */
export const apiErrorStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' ? status : undefined
}
