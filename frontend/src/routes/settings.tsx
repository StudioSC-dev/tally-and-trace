import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { categoryKindOf, isPinnableAccount, queryPhase } from '@tally-trace/shared'
import {
  useGetAccountsQuery,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useGetTagsQuery,
  useCreateTagMutation,
  useUpdateTagMutation,
  useDeleteTagMutation,
} from '../store/api'
import type { Category, Tag } from '../store/api'
import { downloadAuthed } from '../utils/download'
import { HouseholdShares } from '../components/HouseholdShares'
import { SkeletonRows } from '../components/Loading'
import { useConfirm } from '../hooks/useConfirm'
import { localToday } from '@tally-trace/shared'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

// The kind badge on each category row. Transfer has its own, so a transfer and an
// income category of the same name read differently.
const CATEGORY_KIND_BADGE = {
  expense: { label: 'Expense', text: 'text-danger', dot: 'bg-danger' },
  income: { label: 'Income', text: 'text-ok', dot: 'bg-ok' },
  transfer: { label: 'Transfer', text: 'text-info', dot: 'bg-info' },
} as const

const DEFAULT_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777', '#0891b2', '#ca8a04', '#dc2626']

// The API's reason for a refused request (e.g. a duplicate tag name), or a fallback.
const apiErrorMessage = (error: unknown, fallback: string) => {
  const detail = (error as { data?: { detail?: unknown } } | undefined)?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const msg = detail.map((item) => (item as { msg?: string })?.msg).filter(Boolean).join('; ')
    if (msg) return msg
  }
  return fallback
}

function SettingsPage() {
  const { isAuthenticated, isLoading: authLoading, user, updateUser } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  // The cash-flow timeline's main account: active cash accounts held directly (the API checks too).
  const { data: accountsPage } = useGetAccountsQuery({ is_active: true, limit: 1000 }, { skip: !isAuthenticated })
  const pinnable = (accountsPage?.items ?? []).filter(isPinnableAccount)
  const mainAccountId = user?.main_account_id ?? null
  const [savingMain, setSavingMain] = useState(false)
  const [mainError, setMainError] = useState<string | null>(null)

  const categoriesQuery = useGetCategoriesQuery({}, { skip: !isAuthenticated })
  const categories = categoriesQuery.data
  const categoriesPhase = queryPhase(categories, categoriesQuery, !isAuthenticated)
  const [createCategory] = useCreateCategoryMutation()
  const [updateCategory] = useUpdateCategoryMutation()
  const [deleteCategory] = useDeleteCategoryMutation()

  // Category modal
  const emptyCategory = { name: '', description: '', color: DEFAULT_COLORS[0], is_expense: true }
  const [categoryModal, setCategoryModal] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [categoryForm, setCategoryForm] = useState(emptyCategory)

  const tagsQuery = useGetTagsQuery(undefined, { skip: !isAuthenticated })
  const tags = tagsQuery.data
  const tagsPhase = queryPhase(tags, tagsQuery, !isAuthenticated)
  const [createTag] = useCreateTagMutation()
  const [updateTag] = useUpdateTagMutation()
  const [deleteTag] = useDeleteTagMutation()

  // Tag modal
  const emptyTag = { name: '', color: DEFAULT_COLORS[0] as string }
  const [tagModal, setTagModal] = useState(false)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [tagForm, setTagForm] = useState(emptyTag)
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagListError, setTagListError] = useState<string | null>(null)

  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const askConfirm = useConfirm()

  if (!isAuthenticated) return null

  const saveMainAccount = async (value: string) => {
    setMainError(null)
    setSavingMain(true)
    try {
      await updateUser({ main_account_id: value === '' ? null : Number(value) })
    } catch (err) {
      setMainError(apiErrorMessage(err, 'Could not save the main account.'))
    } finally {
      setSavingMain(false)
    }
  }

  const openCreateCategory = () => { setEditingCategory(null); setCategoryForm(emptyCategory); setCategoryModal(true) }
  const openEditCategory = (c: Category) => {
    setEditingCategory(c)
    setCategoryForm({ name: c.name, description: c.description || '', color: c.color || DEFAULT_COLORS[0], is_expense: c.is_expense })
    setCategoryModal(true)
  }
  const submitCategory = async (ev: React.FormEvent) => {
    ev.preventDefault()
    try {
      if (editingCategory) await updateCategory({ id: editingCategory.id, data: categoryForm }).unwrap()
      else await createCategory(categoryForm).unwrap()
      setCategoryModal(false)
    } catch (err) { console.error('Error saving category:', err) }
  }
  // The delete runs from the dialog, so a refusal stays there with the server's reason.
  const removeCategory = async (c: Category) => {
    await askConfirm({
      title: 'Delete category?',
      message: `Delete category "${c.name}"?`,
      confirmLabel: 'Delete category',
      action: () => deleteCategory(c.id).unwrap(),
      errorFallback: 'Could not delete the category.',
    })
  }

  const openCreateTag = () => { setEditingTag(null); setTagForm(emptyTag); setTagError(null); setTagModal(true) }
  const openEditTag = (t: Tag) => {
    setEditingTag(t)
    setTagForm({ name: t.name, color: t.color || DEFAULT_COLORS[0] })
    setTagError(null)
    setTagModal(true)
  }
  const submitTag = async (ev: React.FormEvent) => {
    ev.preventDefault()
    setTagError(null)
    try {
      if (editingTag) {
        // The system tag keeps its name, so only its colour is sent.
        const data = editingTag.is_system ? { color: tagForm.color } : { name: tagForm.name, color: tagForm.color }
        await updateTag({ id: editingTag.id, data }).unwrap()
      } else {
        await createTag({ name: tagForm.name, color: tagForm.color }).unwrap()
      }
      setTagModal(false)
    } catch (err) {
      setTagError(apiErrorMessage(err, 'Could not save the tag.'))
    }
  }
  const removeTag = async (t: Tag) => {
    const accepted = await askConfirm({
      title: 'Delete tag?',
      message: `Delete tag "${t.name}"? It is removed from every record that has it.`,
      confirmLabel: 'Delete tag',
    })
    if (!accepted) return
    setTagListError(null)
    try { await deleteTag(t.id).unwrap() } catch (err) { setTagListError(apiErrorMessage(err, 'Could not delete the tag.')) }
  }

  const exportData = async (kind: 'json' | 'zip') => {
    setDownloading(kind)
    setDownloadError(null)
    try {
      const date = localToday()
      if (kind === 'json') await downloadAuthed('data/export.json', `tally_trace_export_${date}.json`)
      else await downloadAuthed('data/export.csv', `tally_trace_export_${date}.zip`)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-muted mt-1">Choose your cash-flow timeline's main account, manage categories and tags, and export your data.</p>
      </div>

      {/* Cash-flow timeline */}
      <section className="bg-surface border border-line" data-testid="timeline-settings">
        <div className="p-4 sm:p-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Cash-flow timeline</h2>
            <p className="text-sm text-muted">The timeline opens on your main account's own running balance. You can still switch to all cash accounts there.</p>
          </div>
          <div className="md:w-72">
            <label className="label" htmlFor="main-account">Main account</label>
            <select
              id="main-account"
              value={mainAccountId === null ? '' : String(mainAccountId)}
              disabled={savingMain}
              onChange={(e) => saveMainAccount(e.target.value)}
              className="select-field focus-ring disabled:opacity-60"
            >
              <option value="">None (all cash accounts)</option>
              {mainAccountId !== null && !pinnable.some((a) => a.id === mainAccountId) && (
                <option value={String(mainAccountId)} disabled>{accountsPage === undefined ? 'Loading…' : 'Unavailable account'}</option>
              )}
              {pinnable.map((a) => (
                <option key={a.id} value={String(a.id)}>{a.name} ({a.currency})</option>
              ))}
            </select>
          </div>
        </div>
        {mainError && <p role="alert" className="px-4 sm:px-6 pb-3 text-sm text-danger">{mainError}</p>}
      </section>

      {/* Export */}
      <section className="bg-surface border border-line">
        <div className="p-4 sm:p-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Export your data</h2>
            <p className="text-sm text-muted">Download everything you own as one JSON file, or as a ZIP of CSV files (one per table). Accounts shared with you and other people's records on your accounts are included with limited details.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => exportData('json')} disabled={downloading !== null} className="text-sm px-2.5 py-1.5 bg-sunken text-body hover:bg-sunken disabled:opacity-50">
              {downloading === 'json' ? '…' : 'JSON'}
            </button>
            <button onClick={() => exportData('zip')} disabled={downloading !== null} className="text-sm px-2.5 py-1.5 bg-sunken text-body hover:bg-sunken disabled:opacity-50">
              {downloading === 'zip' ? '…' : 'CSV (ZIP)'}
            </button>
          </div>
        </div>
        {downloadError && <p className="px-4 sm:px-6 pb-3 text-sm text-danger">{downloadError}</p>}
      </section>

      {/* Categories */}
      <section className="bg-surface border border-line">
        <div className="p-4 sm:p-6 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Categories</h2>
            <p className="text-sm text-muted">Colour-coded labels for transactions and budgets.</p>
          </div>
          <button onClick={openCreateCategory} className="btn-primary focus-ring">Add category</button>
        </div>
        {categories === undefined ? (
          categoriesPhase === 'error' ? (
            <p role="alert" data-testid="categories-error" className="p-4 sm:p-6 text-sm text-danger">Could not load categories.</p>
          ) : (
            <div data-testid="categories-pending" aria-busy="true" className="p-4 sm:p-6">
              <SkeletonRows rows={3} />
              <span role="status" className="sr-only">Loading categories</span>
            </div>
          )
        ) : categories.length === 0 ? (
          <p className="p-4 sm:p-6 text-sm text-muted">No categories yet.</p>
        ) : (
          <ul className="divide-y divide-line/50">
            {categories.map((c) => (
              <li key={c.id} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-4 w-4 rounded-full flex-shrink-0 border border-black/10" style={{ backgroundColor: c.color || '#9ca3af' }} />
                  <span className="font-medium text-ink truncate">{c.name}</span>
                  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${CATEGORY_KIND_BADGE[categoryKindOf(c)].text}`}>
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${CATEGORY_KIND_BADGE[categoryKindOf(c)].dot}`} />
                    {CATEGORY_KIND_BADGE[categoryKindOf(c)].label}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => openEditCategory(c)} className="text-sm px-2.5 py-1.5 text-ink hover:bg-sunken">Edit</button>
                  <button onClick={() => removeCategory(c)} className="text-sm px-2.5 py-1.5 text-danger hover:bg-sunken">Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tags */}
      <section className="bg-surface border border-line" data-testid="tags-section">
        <div className="p-4 sm:p-6 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Tags</h2>
            <p className="text-sm text-muted">Label accounts, transactions and recurring entries, then filter by tag.</p>
          </div>
          <button onClick={openCreateTag} className="btn-primary focus-ring">Add tag</button>
        </div>
        {tagListError && <p role="alert" className="px-4 sm:px-6 pt-3 text-sm text-danger">{tagListError}</p>}
        {tags === undefined ? (
          tagsPhase === 'error' ? (
            <p role="alert" data-testid="tags-error" className="p-4 sm:p-6 text-sm text-danger">Could not load tags.</p>
          ) : (
            <div data-testid="tags-pending" aria-busy="true" className="p-4 sm:p-6">
              <SkeletonRows rows={3} />
              <span role="status" className="sr-only">Loading tags</span>
            </div>
          )
        ) : tags.length === 0 ? (
          <p className="p-4 sm:p-6 text-sm text-muted">No tags yet.</p>
        ) : (
          <ul className="divide-y divide-line/50">
            {tags.map((t) => (
              <li key={t.id} className="p-4 sm:px-6 flex items-center justify-between gap-4" data-testid="tag-row">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-4 w-4 rounded-full flex-shrink-0 border border-black/10" style={{ backgroundColor: t.color || '#9ca3af' }} />
                  <span className="font-medium text-ink truncate">{t.name}</span>
                  {t.is_system && <span className="badge text-muted">System</span>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => openEditTag(t)}
                    className="text-sm px-2.5 py-1.5 text-ink hover:bg-sunken"
                    aria-label={`${t.is_system ? 'Recolour' : 'Edit'} tag ${t.name}`}
                  >
                    {t.is_system ? 'Recolour' : 'Edit'}
                  </button>
                  <button
                    onClick={() => removeTag(t)}
                    disabled={t.is_system}
                    title={t.is_system ? 'The Household tag cannot be deleted' : undefined}
                    aria-label={`Delete tag ${t.name}`}
                    className="text-sm px-2.5 py-1.5 text-danger hover:bg-sunken disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <HouseholdShares />

      {/* Tag modal */}
      {tagModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6" onClick={() => setTagModal(false)}>
          <div className="min-h-full flex items-center justify-center">
            <div className="bg-surface p-6 w-full max-w-md border border-line" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-xl font-semibold text-ink mb-6">{editingTag ? (editingTag.is_system ? 'Recolour tag' : 'Edit tag') : 'Add tag'}</h2>
              <form onSubmit={submitTag} className="space-y-5">
                <div>
                  <label className="label" htmlFor="tag-name">Name</label>
                  <input
                    id="tag-name"
                    type="text"
                    value={tagForm.name}
                    maxLength={50}
                    disabled={editingTag?.is_system === true}
                    onChange={(e) => setTagForm({ ...tagForm, name: e.target.value })}
                    className="input-field focus-ring disabled:opacity-60"
                    required
                  />
                  {editingTag?.is_system && <p className="mt-1 text-xs text-muted">The Household tag keeps its name. You can change its colour.</p>}
                </div>
                <div>
                  <label className="label">Colour</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {DEFAULT_COLORS.map((col) => (
                      <button key={col} type="button" onClick={() => setTagForm({ ...tagForm, color: col })} className={`h-7 w-7 rounded-full border-2 ${tagForm.color === col ? 'border-line' : 'border-transparent'}`} style={{ backgroundColor: col }} aria-label={`Colour ${col}`} />
                    ))}
                    <input type="color" value={tagForm.color} onChange={(e) => setTagForm({ ...tagForm, color: e.target.value })} className="h-7 w-10 border border-line bg-transparent" aria-label="Custom colour" />
                  </div>
                </div>
                {tagError && <p role="alert" className="text-sm text-danger">{tagError}</p>}
                <div className="flex space-x-3 pt-6 border-t border-line">
                  <button type="submit" className="flex-1 btn-primary focus-ring py-3">{editingTag ? 'Update' : 'Create'}</button>
                  <button type="button" onClick={() => setTagModal(false)} className="flex-1 btn-secondary focus-ring py-3">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Category modal */}
      {categoryModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6" onClick={() => setCategoryModal(false)}>
          <div className="min-h-full flex items-center justify-center">
            <div className="bg-surface p-6 w-full max-w-md border border-line" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-xl font-semibold text-ink mb-6">{editingCategory ? 'Edit category' : 'Add category'}</h2>
              <form onSubmit={submitCategory} className="space-y-5">
                <div>
                  <label className="label">Name</label>
                  <input type="text" value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })} className="input-field focus-ring" required />
                </div>
                <div>
                  <label className="label">Type</label>
                  <select value={categoryForm.is_expense ? 'expense' : 'income'} onChange={(e) => setCategoryForm({ ...categoryForm, is_expense: e.target.value === 'expense' })} className="select-field focus-ring">
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                </div>
                <div>
                  <label className="label">Colour</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {DEFAULT_COLORS.map((col) => (
                      <button key={col} type="button" onClick={() => setCategoryForm({ ...categoryForm, color: col })} className={`h-7 w-7 rounded-full border-2 ${categoryForm.color === col ? 'border-line' : 'border-transparent'}`} style={{ backgroundColor: col }} aria-label={`Colour ${col}`} />
                    ))}
                    <input type="color" value={categoryForm.color} onChange={(e) => setCategoryForm({ ...categoryForm, color: e.target.value })} className="h-7 w-10 border border-line bg-transparent" />
                  </div>
                </div>
                <div>
                  <label className="label">Description (optional)</label>
                  <input type="text" value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} className="input-field focus-ring" />
                </div>
                <div className="flex space-x-3 pt-6 border-t border-line">
                  <button type="submit" className="flex-1 btn-primary focus-ring py-3">{editingCategory ? 'Update' : 'Create'}</button>
                  <button type="button" onClick={() => setCategoryModal(false)} className="flex-1 btn-secondary focus-ring py-3">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
