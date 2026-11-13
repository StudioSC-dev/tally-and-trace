/**
 * Fetch an authenticated API endpoint and trigger a browser download of the
 * response body. Used for the data-export endpoints, which require the Bearer
 * token (so a plain <a href> won't work).
 */
export async function downloadAuthed(path: string, filename: string): Promise<void> {
  const base = `${import.meta.env.VITE_API_URL || ''}/api/v1`
  const token = localStorage.getItem('access_token')
  const res = await fetch(`${base}/${path.replace(/^\//, '')}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
