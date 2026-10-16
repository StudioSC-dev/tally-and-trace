import { createFileRoute, redirect } from '@tanstack/react-router'

// The Household views moved under Accounts. This keeps old links and bookmarks working.
export const Route = createFileRoute('/household')({
  validateSearch: (search: Record<string, unknown>): { sharer?: number } => {
    const sharer = Number(search.sharer)
    return { sharer: Number.isInteger(sharer) && sharer > 0 ? sharer : undefined }
  },
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/accounts/household', search, replace: true })
  },
})
