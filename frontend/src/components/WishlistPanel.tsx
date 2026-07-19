import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import {
  useGetWishlistQuery,
  useGetWishlistPlanQuery,
  useCreateWishlistItemMutation,
  useUpdateWishlistItemMutation,
  useDeleteWishlistItemMutation,
} from '../store/api'
import type { WishlistItem, WishlistItemPriority } from '../store/api'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'

const PRIORITIES: WishlistItemPriority[] = ['critical', 'high', 'medium', 'low']

const PRIORITY_BADGE: Record<WishlistItemPriority, string> = {
  critical: 'bg-rose-100 dark:bg-rose-500/10 text-rose-700 dark:text-rose-400',
  high: 'bg-orange-100 dark:bg-orange-500/10 text-orange-700 dark:text-orange-400',
  medium: 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400',
  low: 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-400',
}

const longDate = (iso?: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d)
}

type FormState = {
  name: string
  estimated_cost: number
  currency: CurrencyCode
  priority: WishlistItemPriority
  url: string
  notes: string
  target_date: string
}

export interface WishlistPanelProps {
  /**
   * When provided, each item gets quick actions to spin up an allocation from it
   * (a budget envelope or a savings target). Used by the Allocations page tab;
   * omitted on the standalone route, where the actions are hidden.
   */
  onCreateAllocationFromItem?: (item: WishlistItem, kind: 'budget' | 'savings') => void
}

export function WishlistPanel({ onCreateAllocationFromItem }: WishlistPanelProps) {
  const { user, isAuthenticated } = useAuth()
  const { format } = useCurrency()
  const defaultCurrency = (user?.default_currency as CurrencyCode) || 'PHP'
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  const [showPurchased, setShowPurchased] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editing, setEditing] = useState<WishlistItem | null>(null)
  const emptyForm: FormState = { name: '', estimated_cost: 0, currency: defaultCurrency, priority: 'medium', url: '', notes: '', target_date: '' }
  const [form, setForm] = useState<FormState>(emptyForm)

  const { data: items = [], isLoading } = useGetWishlistQuery(
    showPurchased ? undefined : { is_purchased: false },
    { skip: !isAuthenticated }
  )
  const { data: plan } = useGetWishlistPlanQuery(undefined, { skip: !isAuthenticated })
  const [createItem] = useCreateWishlistItemMutation()
  const [updateItem] = useUpdateWishlistItemMutation()
  const [deleteItem] = useDeleteWishlistItemMutation()

  const closeModal = () => {
    setIsModalOpen(false)
    setEditing(null)
    setForm({ ...emptyForm, currency: defaultCurrency })
  }

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm, currency: defaultCurrency })
    setIsModalOpen(true)
  }

  const openEdit = (item: WishlistItem) => {
    setEditing(item)
    setForm({
      name: item.name,
      estimated_cost: item.estimated_cost,
      currency: (item.currency as CurrencyCode) || defaultCurrency,
      priority: item.priority,
      url: item.url || '',
      notes: item.notes || '',
      target_date: item.target_date ? item.target_date.slice(0, 10) : '',
    })
    setIsModalOpen(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload: Partial<WishlistItem> = {
      name: form.name,
      estimated_cost: form.estimated_cost,
      currency: form.currency,
      priority: form.priority,
      url: form.url || undefined,
      notes: form.notes || undefined,
      target_date: form.target_date || undefined,
    }
    try {
      if (editing) await updateItem({ id: editing.id, data: payload }).unwrap()
      else await createItem(payload).unwrap()
      closeModal()
    } catch (err) {
      console.error('Error saving wishlist item:', err)
    }
  }

  const togglePurchased = async (item: WishlistItem) => {
    try {
      await updateItem({ id: item.id, data: { is_purchased: !item.is_purchased } }).unwrap()
    } catch (err) {
      console.error('Error updating wishlist item:', err)
    }
  }

  const handleDelete = async (item: WishlistItem) => {
    if (!confirm(`Delete "${item.name}" from your wishlist?`)) return
    try {
      await deleteItem(item.id).unwrap()
    } catch (err) {
      console.error('Error deleting wishlist item:', err)
    }
  }

  const formSymbol = getCurrencySymbol(form.currency)

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Wishlist</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
            Prioritised things you're saving up for — turn any of them into a budget envelope or savings target.
          </p>
        </div>
        <button onClick={openCreate} className="btn-primary focus-ring w-full sm:w-auto justify-center">Add item</button>
      </div>

      {/* Purchase plan */}
      {plan && plan.items.length > 0 && (
        <div className="bg-white dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-800 shadow-sm">
          <div className="p-4 sm:p-6 border-b border-gray-200 dark:border-slate-800">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Purchase plan</h3>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              Assuming {format(plan.savings_rate)}/mo toward the wishlist ({format(plan.monthly_disposable)} disposable) — items saved for in priority order.
            </p>
          </div>
          <ol className="divide-y divide-gray-100 dark:divide-slate-800/50">
            {plan.items.map((p, i) => (
              <li key={p.item_id} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400 text-xs font-semibold">{i + 1}</span>
                  <span className="font-medium text-gray-900 dark:text-white truncate">{p.name}</span>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{format(p.estimated_cost)}</p>
                  <p className="text-xs text-gray-500 dark:text-slate-500">~{longDate(p.estimated_purchase_date)} · {p.cumulative_months} mo</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center justify-end">
        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-slate-400">
          <input type="checkbox" checked={showPurchased} onChange={(e) => setShowPurchased(e.target.checked)} className="rounded border-gray-300 dark:border-slate-600" />
          Show purchased
        </label>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center min-h-48"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" /></div>
      ) : items.length === 0 ? (
        <div className="card p-6 text-center text-gray-500 dark:text-slate-500">Nothing on your wishlist yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {items.map((item) => (
            <article key={item.id} className={`card p-4 sm:p-5 ${item.is_purchased ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${PRIORITY_BADGE[item.priority]}`}>{item.priority}</span>
                    <p className={`text-base font-semibold text-gray-900 dark:text-white ${item.is_purchased ? 'line-through' : ''}`}>{item.name}</p>
                  </div>
                  {item.notes && <p className="text-sm text-gray-600 dark:text-slate-400 mt-1">{item.notes}</p>}
                  <div className="flex flex-wrap gap-2 mt-2 text-xs text-gray-500 dark:text-slate-500">
                    {item.target_date && <span className="inline-flex items-center rounded-full bg-gray-100 dark:bg-slate-800 px-2 py-1">Target {longDate(item.target_date)}</span>}
                    {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-500/10 px-2 py-1 text-blue-700 dark:text-blue-400 hover:underline">Link ↗</a>}
                    {item.is_purchased && item.purchased_at && <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-400">Bought {longDate(item.purchased_at)}</span>}
                  </div>
                  {onCreateAllocationFromItem && !item.is_purchased && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onCreateAllocationFromItem(item, 'savings')}
                        className="inline-flex items-center gap-1 rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-500/20"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8V6m0 12v-2" /></svg>
                        Savings target
                      </button>
                      <button
                        type="button"
                        onClick={() => onCreateAllocationFromItem(item, 'budget')}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" /></svg>
                        Budget envelope
                      </button>
                    </div>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-lg font-bold text-gray-900 dark:text-white">{formatCurrency(item.estimated_cost, item.currency as CurrencyCode)}</p>
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <button onClick={() => togglePurchased(item)} title={item.is_purchased ? 'Mark as not purchased' : 'Mark as purchased'} className="p-1.5 rounded-md text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button onClick={() => openEdit(item)} title="Edit" className="p-1.5 rounded-md text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                    </button>
                    <button onClick={() => handleDelete(item)} title="Delete" className="p-1.5 rounded-md text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Create/Edit modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6" onClick={closeModal}>
          <div className="min-h-full flex items-center justify-center">
            <div className="bg-white dark:bg-slate-800 rounded-xl p-6 w-full max-w-md shadow-2xl border border-gray-200 dark:border-slate-700" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{editing ? 'Edit item' : 'Add item'}</h2>
                <button onClick={closeModal} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="label">Name</label>
                  <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field focus-ring" placeholder="What are you saving for?" required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Estimated cost</label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><span className="text-gray-500 dark:text-slate-400 sm:text-sm">{formSymbol}</span></div>
                      <input type="number" step="0.01" min="0" value={form.estimated_cost} onChange={(e) => setForm({ ...form, estimated_cost: parseFloat(e.target.value) || 0 })} className="input-field pl-7 focus-ring" placeholder="0.00" required />
                    </div>
                  </div>
                  <div>
                    <label className="label">Currency</label>
                    <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as CurrencyCode })} className="select-field focus-ring">
                      {currencyOptions.map((c) => <option key={c} value={c}>{c} ({getCurrencySymbol(c)})</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Priority</label>
                    <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as WishlistItemPriority })} className="select-field focus-ring capitalize">
                      {PRIORITIES.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Target date (optional)</label>
                    <input type="date" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} className="input-field focus-ring" />
                  </div>
                </div>
                <div>
                  <label className="label">Link (optional)</label>
                  <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input-field focus-ring" placeholder="https://..." />
                </div>
                <div>
                  <label className="label">Notes (optional)</label>
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input-field focus-ring resize-none" rows={2} placeholder="Any details" />
                </div>
                <div className="flex space-x-3 pt-6 border-t border-gray-200 dark:border-slate-700">
                  <button type="submit" className="flex-1 btn-primary focus-ring py-3 px-4 text-base rounded-lg">{editing ? 'Update' : 'Add'}</button>
                  <button type="button" onClick={closeModal} className="flex-1 btn-secondary focus-ring py-3 px-4 text-base rounded-lg">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
