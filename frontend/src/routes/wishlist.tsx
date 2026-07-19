import { createFileRoute, redirect } from '@tanstack/react-router'

// Wishlist now lives as a tab inside Allocations. Keep this path as a redirect
// so existing bookmarks/links don't 404.
export const Route = createFileRoute('/wishlist')({
  beforeLoad: () => {
    throw redirect({ to: '/allocations' })
  },
})
