import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  useGetEntitiesQuery,
  useCreateEntityMutation,
  useUpdateEntityMutation,
  useDeleteEntityMutation,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
} from '../store/api'
import type { Entity, EntityType, Category } from '../store/api'
import { downloadAuthed } from '../utils/download'
import { CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

const DEFAULT_COLORS = ['#2563eb', '#7c3aed', '#16a34a', '#f97316', '#db2777', '#0891b2', '#ca8a04', '#dc2626']

function SettingsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const navigate = useNavigate()
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  useEffect(() => {
    if (!authLoading && !isAuthenticated) navigate({ to: '/login', search: { message: undefined } })
  }, [authLoading, isAuthenticated, navigate])

  const { data: entities = [] } = useGetEntitiesQuery(undefined, { skip: !isAuthenticated })
  const { data: categories = [] } = useGetCategoriesQuery({}, { skip: !isAuthenticated })
  const [createEntity] = useCreateEntityMutation()
  const [updateEntity] = useUpdateEntityMutation()
  const [deleteEntity] = useDeleteEntityMutation()
  const [createCategory] = useCreateCategoryMutation()
  const [updateCategory] = useUpdateCategoryMutation()
  const [deleteCategory] = useDeleteCategoryMutation()

  // Entity modal
  const emptyEntity = { name: '', entity_type: 'personal' as EntityType, description: '', default_currency: 'PHP' }
  const [entityModal, setEntityModal] = useState(false)
  const [editingEntity, setEditingEntity] = useState<Entity | null>(null)
  const [entityForm, setEntityForm] = useState(emptyEntity)

  // Category modal
  const emptyCategory = { name: '', description: '', color: DEFAULT_COLORS[0], is_expense: true }
  const [categoryModal, setCategoryModal] = useState(false)
  const [editingCategory, setEditingCategory] = useState<Category | null>(null)
  const [categoryForm, setCategoryForm] = useState(emptyCategory)

  const [downloading, setDownloading] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  if (!isAuthenticated) return null

  const openCreateEntity = () => { setEditingEntity(null); setEntityForm(emptyEntity); setEntityModal(true) }
  const openEditEntity = (e: Entity) => {
    setEditingEntity(e)
    setEntityForm({ name: e.name, entity_type: e.entity_type, description: e.description || '', default_currency: e.default_currency || 'PHP' })
    setEntityModal(true)
  }
  const submitEntity = async (ev: React.FormEvent) => {
    ev.preventDefault()
    try {
      if (editingEntity) await updateEntity({ id: editingEntity.id, data: entityForm }).unwrap()
      else await createEntity(entityForm).unwrap()
      setEntityModal(false)
    } catch (err) { console.error('Error saving entity:', err) }
  }
  const deactivateEntity = async (e: Entity) => {
    if (!confirm(`Deactivate "${e.name}"? Its data is kept but it's hidden from most views.`)) return
    try { await deleteEntity(e.id).unwrap() } catch (err) { console.error('Error deactivating entity:', err) }
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
  const removeCategory = async (c: Category) => {
    if (!confirm(`Delete category "${c.name}"?`)) return
    try { await deleteCategory(c.id).unwrap() } catch (err) { console.error('Error deleting category:', err) }
  }

  const exportEntity = async (e: Entity, fmt: 'json' | 'csv') => {
    const key = `${e.id}-${fmt}`
    setDownloading(key)
    setDownloadError(null)
    try {
      const ext = fmt === 'json' ? 'json' : 'csv'
      await downloadAuthed(`data/entities/${e.id}/export.${ext}`, `tally_trace_${e.name.replace(/\s+/g, '_')}.${ext}`)
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
        <p className="text-sm text-muted mt-1">Manage entities, categories, and export your data.</p>
      </div>

      {/* Entities + export */}
      <section className="bg-surface border border-line">
        <div className="p-4 sm:p-6 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-ink">Entities</h2>
            <p className="text-sm text-muted">Separate financial contexts (personal, business). Export each to JSON or CSV.</p>
          </div>
          <button onClick={openCreateEntity} className="btn-primary focus-ring">Add entity</button>
        </div>
        {downloadError && <p className="px-4 sm:px-6 pt-3 text-sm text-danger">{downloadError}</p>}
        {entities.length === 0 ? (
          <p className="p-4 sm:p-6 text-sm text-muted">No entities yet.</p>
        ) : (
          <ul className="divide-y divide-line/50">
            {entities.map((e) => (
              <li key={e.id} className={`p-4 sm:px-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between ${e.is_active ? '' : 'opacity-60'}`}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{e.name}</span>
                    <span className="inline-flex items-center rounded-full bg-sunken px-2 py-0.5 text-xs font-medium text-body capitalize">{e.entity_type}</span>
                    {!e.is_active && <span className="inline-flex items-center rounded-full bg-sunken px-2 py-0.5 text-xs text-body">Inactive</span>}
                  </div>
                  {e.description && <p className="text-sm text-muted mt-0.5">{e.description}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => exportEntity(e, 'json')} disabled={downloading === `${e.id}-json`} className="text-sm px-2.5 py-1.5 bg-sunken text-body hover:bg-sunken disabled:opacity-50">
                    {downloading === `${e.id}-json` ? '…' : 'JSON'}
                  </button>
                  <button onClick={() => exportEntity(e, 'csv')} disabled={downloading === `${e.id}-csv`} className="text-sm px-2.5 py-1.5 bg-sunken text-body hover:bg-sunken disabled:opacity-50">
                    {downloading === `${e.id}-csv` ? '…' : 'CSV'}
                  </button>
                  <button onClick={() => openEditEntity(e)} className="text-sm px-2.5 py-1.5 text-ink hover:bg-sunken">Edit</button>
                  {e.is_active && <button onClick={() => deactivateEntity(e)} className="text-sm px-2.5 py-1.5 text-danger hover:bg-sunken">Deactivate</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
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

      {/* Entity modal */}
      {entityModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6" onClick={() => setEntityModal(false)}>
          <div className="min-h-full flex items-center justify-center">
            <div className="bg-surface p-6 w-full max-w-md border border-line" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-xl font-semibold text-ink mb-6">{editingEntity ? 'Edit entity' : 'Add entity'}</h2>
              <form onSubmit={submitEntity} className="space-y-5">
                <div>
                  <label className="label">Name</label>
                  <input type="text" value={entityForm.name} onChange={(e) => setEntityForm({ ...entityForm, name: e.target.value })} className="input-field focus-ring" required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Type</label>
                    <select value={entityForm.entity_type} onChange={(e) => setEntityForm({ ...entityForm, entity_type: e.target.value as EntityType })} className="select-field focus-ring">
                      <option value="personal">Personal</option>
                      <option value="business">Business</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">Default currency</label>
                    <select value={entityForm.default_currency} onChange={(e) => setEntityForm({ ...entityForm, default_currency: e.target.value })} className="select-field focus-ring">
                      {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Description (optional)</label>
                  <input type="text" value={entityForm.description} onChange={(e) => setEntityForm({ ...entityForm, description: e.target.value })} className="input-field focus-ring" />
                </div>
                <div className="flex space-x-3 pt-6 border-t border-line">
                  <button type="submit" className="flex-1 btn-primary focus-ring py-3">{editingEntity ? 'Update' : 'Create'}</button>
                  <button type="button" onClick={() => setEntityModal(false)} className="flex-1 btn-secondary focus-ring py-3">Cancel</button>
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
