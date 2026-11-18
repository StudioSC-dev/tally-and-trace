import { useMemo, useState } from 'react'
import { queryPhase } from '@tally-trace/shared'
import { useAuth } from '../contexts/AuthContext'
import { useCurrency } from '../hooks/useCurrency'
import { useConfirm } from '../hooks/useConfirm'
import {
  useGetWishlistQuery,
  useGetWishlistPlanQuery,
  useCreateWishlistItemMutation,
  useUpdateWishlistItemMutation,
  useDeleteWishlistItemMutation,
} from '../store/api'
import type { WishlistItem, WishlistItemPriority } from '../store/api'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { Button } from './Button'
import { Icon } from './Icon'

/** A row's icon action: 4px padding and the Button's 1px border, held at 28px square, the old 6px around a 16px icon. */
const ICON_ACTION = 'p-1 min-h-7 min-w-7'

const PRIORITIES: WishlistItemPriority[] = ['critical', 'high', 'medium', 'low']

// Priority reads as a dot plus a label, never a tinted pill — the status colour
// belongs to the text, so it cannot collide with the fill behind it.
const PRIORITY_BADGE: Record<WishlistItemPriority, string> = {
  critical: 'text-danger',
  high: 'text-warn',
  medium: 'text-body',
  low: 'text-muted',
}

const PRIORITY_DOT: Record<WishlistItemPriority, string> = {
  critical: 'bg-danger',
  high: 'bg-warn',
  medium: 'bg-line-strong',
  low: 'bg-line',
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

  const wishlistQuery = useGetWishlistQuery(
    showPurchased ? undefined : { is_purchased: false },
    { skip: !isAuthenticated }
  )
  const items = wishlistQuery.data
  const wishlistPhase = queryPhase(items, wishlistQuery, !isAuthenticated)
  const { data: plan } = useGetWishlistPlanQuery(undefined, { skip: !isAuthenticated })
  const [createItem] = useCreateWishlistItemMutation()
  const [updateItem] = useUpdateWishlistItemMutation()
  const [deleteItem] = useDeleteWishlistItemMutation()
  const askConfirm = useConfirm()

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
    // The delete runs from the dialog, so a refusal stays there with the server's reason.
    await askConfirm({
      title: 'Delete wishlist item?',
      message: `Delete "${item.name}" from your wishlist?`,
      confirmLabel: 'Delete item',
      action: () => deleteItem(item.id).unwrap(),
      errorFallback: 'Could not delete the wishlist item.',
    })
  }

  const formSymbol = getCurrencySymbol(form.currency)

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Wishlist</h2>
          <p className="text-sm text-muted mt-1">
            Prioritised things you're saving up for. Turn any of them into a budget envelope or savings target.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} className="w-full sm:w-auto justify-center">Add item</Button>
      </div>

      {/* Purchase plan */}
      {plan && plan.items.length > 0 && (
        <div className="bg-surface border border-line">
          <div className="p-4 sm:p-6 border-b border-line">
            <h3 className="text-base font-semibold text-ink">Purchase plan</h3>
            <p className="text-sm text-muted">
              Assuming {format(plan.savings_rate)}/mo toward the wishlist ({format(plan.monthly_disposable)} disposable). Items are saved for in priority order.
            </p>
          </div>
          <ol className="divide-y divide-line/50">
            {plan.items.map((p, i) => (
              <li key={p.item_id} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-ink text-xs font-semibold">{i + 1}</span>
                  <span className="font-medium text-ink truncate">{p.name}</span>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-ink">{format(p.estimated_cost)}</p>
                  {p.estimated_purchase_date
                    ? <p className="text-xs text-muted">~{longDate(p.estimated_purchase_date)} · {p.cumulative_months} mo</p>
                    : <p className="text-xs text-warn">{p.note ?? 'No date yet'}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center justify-end">
        <label className="inline-flex items-center gap-2 text-sm text-body">
          <input type="checkbox" checked={showPurchased} onChange={(e) => setShowPurchased(e.target.checked)} className="border-line" />
          Show purchased
        </label>
      </div>

      {/* List */}
      {wishlistPhase === 'error' ? (
        <div className="card p-6 text-center space-y-3" role="alert" data-testid="wishlist-error">
          <p className="text-sm text-danger">Could not load your wishlist.</p>
          <Button variant="secondary" onClick={() => void wishlistQuery.refetch()} data-testid="wishlist-retry">
            Retry
          </Button>
        </div>
      ) : wishlistPhase !== 'ready' || !items ? (
        <div className="flex items-center justify-center min-h-48"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ink" /></div>
      ) : items.length === 0 ? (
        <div className="card p-6 text-center text-muted">Nothing on your wishlist yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {items.map((item) => (
            <article key={item.id} className={`card p-4 sm:p-5 ${item.is_purchased ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium capitalize ${PRIORITY_BADGE[item.priority]}`}>
                      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[item.priority]}`} />
                      {item.priority}
                    </span>
                    <p className={`text-base font-semibold text-ink ${item.is_purchased ? 'line-through' : ''}`}>{item.name}</p>
                  </div>
                  {item.notes && <p className="text-sm text-body mt-1">{item.notes}</p>}
                  <div className="flex flex-wrap gap-2 mt-2 text-xs text-muted">
                    {item.target_date && <span className="inline-flex items-center rounded-full bg-sunken px-2 py-1">Target {longDate(item.target_date)}</span>}
                    {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-ink hover:underline">Link <Icon name="external-link" /></a>}
                    {item.is_purchased && item.purchased_at && <span className="inline-flex items-center rounded-full px-2 py-1 text-ok">Bought {longDate(item.purchased_at)}</span>}
                  </div>
                  {onCreateAllocationFromItem && !item.is_purchased && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => onCreateAllocationFromItem(item, 'savings')}
                        className="gap-1 px-3 py-1 text-xs"
                      >
                        <Icon name="savings" />
                        Savings target
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => onCreateAllocationFromItem(item, 'budget')}
                        className="gap-1 px-3 py-1 text-xs"
                      >
                        <Icon name="budget" />
                        Budget envelope
                      </Button>
                    </div>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-lg font-bold text-ink">{formatCurrency(item.estimated_cost, item.currency as CurrencyCode)}</p>
                  <div className="mt-2 flex items-center justify-end gap-1">
                    <Button variant="quiet" onClick={() => togglePurchased(item)} title={item.is_purchased ? 'Mark as not purchased' : 'Mark as purchased'} aria-label={item.is_purchased ? 'Mark as not purchased' : 'Mark as purchased'} className={ICON_ACTION}>
                      <Icon name="check" />
                    </Button>
                    <Button variant="quiet" onClick={() => openEdit(item)} title="Edit" aria-label="Edit" className={ICON_ACTION}>
                      <Icon name="edit" />
                    </Button>
                    <Button variant="danger" onClick={() => handleDelete(item)} title="Delete" aria-label="Delete" className={ICON_ACTION}>
                      <Icon name="delete" />
                    </Button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Create/Edit modal */}
      {isModalOpen && (
        <div className="modal-backdrop fixed inset-0 z-50 overflow-y-auto bg-scrim/60" onClick={closeModal}>
          <div className="min-h-full flex items-center justify-center">
            <div className="bg-surface p-6 w-full max-w-md border border-line" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold text-ink">{editing ? 'Edit item' : 'Add item'}</h2>
                <button onClick={closeModal} className="text-muted hover:text-body" aria-label="Close wishlist modal">
                  <Icon name="close" />
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
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><span className="text-muted sm:text-sm">{formSymbol}</span></div>
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
                <div className="flex space-x-3 pt-6 border-t border-line">
                  <Button variant="primary" type="submit" className="flex-1 py-3 px-4 text-base">{editing ? 'Update' : 'Add'}</Button>
                  <Button variant="quiet" onClick={closeModal} className="flex-1 py-3 px-4 text-base">Cancel</Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
