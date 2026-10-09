import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
} from '../store/api'
import type { Category } from '../store/api'
import { downloadAuthed } from '../utils/download'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

const DEFAULT_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777', '#0891b2', '#ca8a04', '#dc2626']

function SettingsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  const { data: categories = [] } = useGetCategoriesQuery({}, { skip: !isAuthenticated })
  const [createCategory] = useCreateCategoryMutation()
  const [updateCategory] = useUpdateCategoryMutation()
  const [deleteCategory] = useDeleteCategoryMutation()

  // Category modal
  const emptyCategory = { name: '', description: '', color: DEFAULT_COLORS[0], is_expense: true }
  const [categoryModal, setCategoryModal] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [categoryForm, setCategoryForm] = useState(emptyCategory)

  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  if (!isAuthenticated) return null

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
  const removeCategory = async (c: Category) => {
    if (!confirm(`Delete category "${c.name}"?`)) return
    try { await deleteCategory(c.id).unwrap() } catch (err) { console.error('Error deleting category:', err) }
  }

  const exportData = async (kind: 'json' | 'zip') => {
    setDownloading(kind)
    setDownloadError(null)
    try {
      const date = new Date().toISOString().slice(0, 10)
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
        <p className="text-sm text-muted mt-1">Manage categories and export your data.</p>
      </div>

      {/* Export */}
      <section className="bg-surface border border-line">
        <div className="p-4 sm:p-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Export your data</h2>
            <p className="text-sm text-muted">Download everything you own as one JSON file, or as a ZIP of CSV files (one per table).</p>
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
        {categories.length === 0 ? (
          <p className="p-4 sm:p-6 text-sm text-muted">No categories yet.</p>
        ) : (
          <ul className="divide-y divide-line/50">
            {categories.map((c) => (
              <li key={c.id} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="h-4 w-4 rounded-full flex-shrink-0 border border-black/10" style={{ backgroundColor: c.color || '#9ca3af' }} />
                  <span className="font-medium text-ink truncate">{c.name}</span>
                  <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${c.is_expense ? 'text-danger' : 'text-ok'}`}>
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.is_expense ? 'bg-danger' : 'bg-ok'}`} />
                    {c.is_expense ? 'Expense' : 'Income'}
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
