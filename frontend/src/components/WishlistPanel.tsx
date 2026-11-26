import { useMemo, useState } from 'react'
import { accountPickerGroups, centavosToAmount, queryPhase, trySplitInstallment } from '@tally-trace/shared'
import type {
  WishlistCheckStatus,
  WishlistFreeFlowRow,
  WishlistOutlook,
  WishlistPaymentPlan,
  WishlistPlanItem,
} from '@tally-trace/shared'
import { useAuth } from '../contexts/AuthContext'
import { useConfirm } from '../hooks/useConfirm'
import { useToast } from '../hooks/useToast'
import { apiErrorMessage } from '../utils/apiError'
import {
  useGetAccountsQuery,
  useGetWishlistQuery,
  useGetWishlistPlanQuery,
  useGetWishlistOutlookQuery,
  useCreateWishlistItemMutation,
  useUpdateWishlistItemMutation,
  useDeleteWishlistItemMutation,
} from '../store/api'
import type { WishlistItem, WishlistItemPriority } from '../store/api'
import { formatCurrency, getCurrencySymbol, CurrencyCode, CURRENCY_CONFIGS } from '../utils/currency'
import { Button } from './Button'
import { Icon } from './Icon'
import { EmptyState } from './EmptyState'
import { PickerOptGroups } from './PickerOptGroups'
import { SegmentedControl } from './SegmentedControl'
import { StatusText } from './StatusText'
import type { StatusTone } from './StatusText'

/** A row's icon action: 2px padding and the Button's 1px border around the 20px icon (26px), held at 28px square as before. */
const ICON_ACTION = 'p-0.5 min-h-7 min-w-7'

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

const monthLabel = (ym: string) => {
  const d = new Date(`${ym}-01T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ym
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d)
}

const MONTHS_MIN = 2
const MONTHS_MAX = 60

const RECURRING_LINK = { label: 'Open Recurring', to: '/allocations?tab=recurring' }

const BUDGET_BADGE: Record<WishlistCheckStatus, { tone: StatusTone; text: string }> = {
  fits: { tone: 'ok', text: 'Fits your monthly budget' },
  over: { tone: 'danger', text: 'Over your monthly budget' },
  unknown: { tone: 'muted', text: 'Not enough data' },
}

const CARD_BADGE: Record<WishlistCheckStatus, { tone: StatusTone; text: string }> = {
  fits: { tone: 'ok', text: 'Fits card limit' },
  over: { tone: 'danger', text: 'Over card limit' },
  unknown: { tone: 'muted', text: 'Card limit unknown' },
}

const PAYMENT_OPTIONS = [
  { value: 'full' as const, label: 'Full' },
  { value: 'installment' as const, label: 'Installments' },
]

/** A want's level; Critical is the other choice, an urgent need (STU-791). */
const WANT_OPTIONS = [
  { value: 'high' as const, label: 'High' },
  { value: 'medium' as const, label: 'Medium' },
  { value: 'low' as const, label: 'Low' },
]

// What a currency row says when it has no figures, as the API words it (`free_flow.py`, `wishlist_projection.py`).
const NOT_ESTIMATED_TEXT = 'Needs one full month of history'
const INCOMPLETE_TEXT = 'Money in more than one currency is involved, so this cannot be estimated yet'
const noProjectionText = (currency: string) => `No projected income or expenses in ${currency}, so this can't be judged yet.`

const PURCHASE_NOTE = 'Marking an item purchased does not record the payment. Its estimate moves only once you record the transaction.'

/** The months of history a figure rests on, when it is a short sample: "based on your last 4 full months". */
const sampleNote = (months: number): string | null =>
  months >= 1 && months < 12 ? `Based on your last ${months} full month${months === 1 ? '' : 's'}` : null

/**
 * An installment item's monthly payment worked out here, for an item whose outlook is not requested (a purchased one):
 * the price over the months, rounded half-up to the centavo, as the API splits it. Null when the price is too small to split.
 */
const monthlyAmountOf = (item: WishlistItem): number | null => {
  if (item.installment_months == null) return null
  const split = trySplitInstallment(Math.round(item.estimated_cost * 100), item.installment_months)
  return split === null ? null : centavosToAmount(split.monthly)
}

/** "₱5,416.67/mo × 12 months", in the item's currency. */
const installmentLine = (amount: number, currency: CurrencyCode, months: number) =>
  `${formatCurrency(amount, currency)}/mo \u00d7 ${months} months`

type FormState = {
  name: string
  estimated_cost: number
  currency: CurrencyCode
  priority: WishlistItemPriority
  url: string
  notes: string
  target_date: string
  /** 0 is no account. */
  account_id: number
  payment_plan: WishlistPaymentPlan
  /** Kept as typed; read as a whole number from 2 to 60 on save. */
  installment_months: string
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
  const defaultCurrency = (user?.default_currency as CurrencyCode) || 'PHP'
  const currencyOptions = useMemo(() => Object.keys(CURRENCY_CONFIGS) as CurrencyCode[], [])

  const [showPurchased, setShowPurchased] = useState(false)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editing, setEditing] = useState<WishlistItem | null>(null)
  const emptyForm: FormState = { name: '', estimated_cost: 0, currency: defaultCurrency, priority: 'medium', url: '', notes: '', target_date: '', account_id: 0, payment_plan: 'full', installment_months: '' }
  const [form, setForm] = useState<FormState>(emptyForm)

  const wishlistQuery = useGetWishlistQuery(
    showPurchased ? undefined : { is_purchased: false },
    { skip: !isAuthenticated }
  )
  const items = wishlistQuery.data
  const wishlistPhase = queryPhase(items, wishlistQuery, !isAuthenticated)
  const { data: plan } = useGetWishlistPlanQuery(undefined, { skip: !isAuthenticated })
  const flowRows = plan?.net_flow ?? []
  // A critical item is an urgent need; anything else (or an answer with no priority) is a want, queued in the API's order.
  const urgentItems = useMemo(() => (plan?.items ?? []).filter((p) => p.priority === 'critical'), [plan])
  const wantItems = useMemo(() => (plan?.items ?? []).filter((p) => p.priority !== 'critical'), [plan])
  const { data: accountsPage } = useGetAccountsQuery({ is_active: true, limit: 100 }, { skip: !isAuthenticated })
  // The API takes any account the caller can add records to (owner, admin or editor; `can_add_transactions`, as the
  // recurring form's writable accounts), never a loan; an installment is paid from a card.
  const payAccounts = useMemo(
    () => (accountsPage?.items ?? []).filter((a) => a.permissions.can_add_transactions && a.account_type !== 'loan'),
    [accountsPage],
  )
  const cardAccounts = useMemo(() => payAccounts.filter((a) => a.account_type === 'credit'), [payAccounts])
  const accountName = (id?: number | null) => payAccounts.find((a) => a.id === id)?.name
  const [saveError, setSaveError] = useState<string | null>(null)
  const [purchaseError, setPurchaseError] = useState<{ id: number; message: string } | null>(null)
  const showToast = useToast()
  const [createItem] = useCreateWishlistItemMutation()
  const [updateItem] = useUpdateWishlistItemMutation()
  const [deleteItem] = useDeleteWishlistItemMutation()
  const askConfirm = useConfirm()

  const closeModal = () => {
    setSaveError(null)
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
      account_id: item.account_id ?? 0,
      payment_plan: item.payment_plan,
      installment_months: item.installment_months != null ? String(item.installment_months) : '',
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
      account_id: form.account_id || null,
      payment_plan: form.payment_plan,
      installment_months: form.payment_plan === 'installment' ? parseInt(form.installment_months, 10) : null,
    }
    setSaveError(null)
    try {
      if (editing) {
        const saved = await updateItem({ id: editing.id, data: payload }).unwrap()
        // Switching a purchased item to Installments creates its card installment in this request; the notice says so.
        if (saved.notice) showToast(saved.notice)
      } else await createItem(payload).unwrap()
      closeModal()
    } catch (err) {
      // A refusal (a locked field once the installment exists, a card that cannot take it) shows in the form, with the API's reason.
      setSaveError(apiErrorMessage(err) || 'Could not save the wishlist item.')
    }
  }

  const togglePurchased = async (item: WishlistItem) => {
    if (item.is_purchased) {
      // Un-marking never undoes the card installment the purchase created, so say so before it runs.
      await askConfirm({
        title: 'Mark as not purchased?',
        message: item.installment_entry_id
          ? `"${item.name}" goes back on your wishlist. Its card installment keeps running in Recurring; delete it there if this purchase did not happen.`
          : `"${item.name}" goes back on your wishlist.`,
        link: item.installment_entry_id ? RECURRING_LINK : undefined,
        confirmLabel: 'Mark as not purchased',
        tone: 'default',
        action: async () => {
          const saved = await updateItem({ id: item.id, data: { is_purchased: false } }).unwrap()
          if (saved.notice) showToast(saved.notice)
        },
        errorFallback: 'Could not mark the item as not purchased.',
      })
      return
    }
    setPurchaseError(null)
    try {
      const saved = await updateItem({ id: item.id, data: { is_purchased: true } }).unwrap()
      if (saved.notice) showToast(saved.notice)
    } catch (err) {
      // A refusal (no exchange rate for the installment, say) leaves the item unpurchased; its reason shows on the card.
      setPurchaseError({ id: item.id, message: apiErrorMessage(err) || 'Could not mark the item as purchased.' })
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
  const isInstallment = form.payment_plan === 'installment'
  const accountChoices = isInstallment ? cardAccounts : payAccounts
  // Once marking the item purchased created its card installment, the API refuses payment changes.
  const paymentLocked = editing?.installment_entry_id != null

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">Wishlist</h2>
          <p className="text-sm text-muted mt-1">
            Urgent needs come first. Everything else is saved for after your savings. Turn any of them into a budget envelope or savings target.
          </p>
          <p className="text-sm text-muted mt-1" data-testid="purchase-note">{PURCHASE_NOTE}</p>
        </div>
        <Button variant="primary" onClick={openCreate} className="w-full sm:w-auto justify-center">Add item</Button>
      </div>

      {/* Purchase plan */}
      {plan && (plan.items.length > 0 || plan.installments.length > 0) && (
        <div className="bg-surface border border-line" data-testid="purchase-plan">
          <div className="p-4 sm:p-6 border-b border-line space-y-3">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-base font-semibold text-ink">Purchase plan</h3>
              {plan.items.length > 0 && flowRows.length > 0 && <span className="text-sm text-muted">Per month</span>}
            </div>
            {plan.items.length > 0 && flowRows.map((row) => <FlowSummary key={row.currency} row={row} showCurrency={flowRows.length > 1} />)}
          </div>
          {urgentItems.length > 0 && (
            <section className="p-4 sm:p-6 border-b border-line space-y-3" aria-labelledby="plan-urgent-heading" data-testid="plan-urgent">
              <div>
                <h4 id="plan-urgent-heading" className="text-sm font-semibold text-ink">Urgent needs</h4>
                <p className="text-sm text-muted">Bought when you need them, ahead of your savings.</p>
              </div>
              <ul className="space-y-3">
                {urgentItems.map((p) => (
                  <UrgentRow key={p.item_id} item={p} defaultCurrency={defaultCurrency} row={flowRows.find((r) => r.currency === (p.currency ?? defaultCurrency))} />
                ))}
              </ul>
            </section>
          )}
          {wantItems.length > 0 && (
            <section aria-labelledby="plan-wants-heading" data-testid="plan-wants">
              <div className="px-4 pt-4 sm:px-6">
                <h4 id="plan-wants-heading" className="text-sm font-semibold text-ink">Wants</h4>
                <p className="text-sm text-muted">Saved for from what is left after your savings, in priority order.</p>
              </div>
              <ol className="divide-y divide-line/50 mt-2" data-testid="plan-queue">
                {wantItems.map((p, i) => (
                  <li key={p.item_id} className="p-4 sm:px-6 flex items-center justify-between gap-4" data-testid={`plan-item-${p.item_id}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-ink text-xs font-semibold">{i + 1}</span>
                      <div className="min-w-0">
                        <span className="font-medium text-ink truncate block">{p.name}</span>
                        {p.priority && <span className="text-xs text-muted capitalize">{p.priority}</span>}
                      </div>
                    </div>
                    <PlanWhen item={p} defaultCurrency={defaultCurrency} />
                  </li>
                ))}
              </ol>
            </section>
          )}
          {plan.installments.length > 0 && (
            <section className={plan.items.length > 0 ? 'border-t border-line' : ''} aria-labelledby="plan-installments-heading" data-testid="plan-installments">
              <div className="px-4 pt-4 sm:px-6">
                <h4 id="plan-installments-heading" className="text-sm font-semibold text-ink">Paid by installments</h4>
                <p className="text-sm text-muted">Paid monthly on a card, so they are not saved up for.</p>
              </div>
              <ul className="divide-y divide-line/50">
                {plan.installments.map((p) => (
                  <li key={p.item_id} className="p-4 sm:px-6 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <span className="font-medium text-ink truncate block">{p.name}</span>
                      {accountName(p.account_id) && <span className="text-xs text-muted">{accountName(p.account_id)}</span>}
                    </div>
                    <p className="text-sm font-semibold text-ink text-right flex-shrink-0">
                      {installmentLine(p.monthly_amount, p.currency as CurrencyCode, p.installment_months)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
        <EmptyState message="Nothing on your wishlist yet." action={{ label: 'Add your first item', onClick: openCreate }} />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {items.map((item) => (
            <WishlistCard
              key={item.id}
              item={item}
              accountName={accountName(item.account_id)}
              error={purchaseError?.id === item.id ? purchaseError.message : null}
              onCreateAllocationFromItem={onCreateAllocationFromItem}
              onTogglePurchased={togglePurchased}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
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
                      <input type="number" step="0.01" min="0" value={form.estimated_cost} onChange={(e) => setForm({ ...form, estimated_cost: parseFloat(e.target.value) || 0 })} disabled={paymentLocked} className="input-field pl-7 focus-ring" placeholder="0.00" required />
                    </div>
                  </div>
                  <div>
                    <label className="label" htmlFor="wishlist-currency">Currency</label>
                    <select id="wishlist-currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as CurrencyCode })} disabled={paymentLocked} className="select-field focus-ring">
                      {currencyOptions.map((c) => <option key={c} value={c}>{c} ({getCurrencySymbol(c)})</option>)}
                    </select>
                  </div>
                </div>
                <fieldset className="space-y-2" data-testid="wishlist-priority">
                  <legend className="label">Priority</legend>
                  <label className={`flex items-start gap-3 border p-3 ${form.priority === 'critical' ? 'border-danger' : 'border-line'}`}>
                    <input type="radio" name="wishlist-priority" checked={form.priority === 'critical'} onChange={() => setForm({ ...form, priority: 'critical' })} className="mt-1" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-semibold text-ink">Critical</span>
                      <span className="text-sm text-muted">An urgent need. It comes before your savings.</span>
                    </span>
                  </label>
                  <div className={`border p-3 space-y-2 ${form.priority !== 'critical' ? 'border-ink' : 'border-line'}`}>
                    <label className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="wishlist-priority"
                        checked={form.priority !== 'critical'}
                        onChange={() => setForm({ ...form, priority: form.priority === 'critical' ? 'medium' : form.priority })}
                        className="mt-1"
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-semibold text-ink">A want</span>
                        <span className="text-sm text-muted">Saved for after your savings, in this order.</span>
                      </span>
                    </label>
                    <SegmentedControl
                      className="flex flex-wrap gap-2 pl-7"
                      aria-label="How much you want it"
                      options={WANT_OPTIONS}
                      value={form.priority}
                      onChange={(priority) => setForm({ ...form, priority })}
                      segmentClassName="px-3 py-1 text-sm"
                    />
                  </div>
                </fieldset>
                <div>
                  <label className="label">Target date (optional)</label>
                  <input type="date" value={form.target_date} onChange={(e) => setForm({ ...form, target_date: e.target.value })} className="input-field focus-ring" />
                </div>
                <fieldset className="space-y-3" disabled={paymentLocked} data-testid="wishlist-payment">
                  <div>
                    <label className="label" htmlFor="wishlist-pay-from">Pay from</label>
                    <select
                      id="wishlist-pay-from"
                      value={form.account_id}
                      onChange={(e) => setForm({ ...form, account_id: parseInt(e.target.value, 10) })}
                      className="select-field focus-ring"
                      required={isInstallment}
                    >
                      <option value={0}>{isInstallment ? 'Select a credit card' : 'No account'}</option>
                      {form.account_id !== 0 && !accountChoices.some((a) => a.id === form.account_id) && (
                        <option value={form.account_id}>{accountName(form.account_id) ?? `Account ${form.account_id}`}</option>
                      )}
                      <PickerOptGroups groups={accountPickerGroups(accountChoices)} text={(o) => `${o.label} (${o.hint})`} />
                    </select>
                  </div>
                  <div>
                    <span className="label" id="wishlist-payment-label">Payment</span>
                    <SegmentedControl
                      className="mt-1 flex flex-wrap gap-2"
                      aria-labelledby="wishlist-payment-label"
                      options={PAYMENT_OPTIONS}
                      value={form.payment_plan}
                      onChange={(plan) =>
                        setForm({
                          ...form,
                          payment_plan: plan,
                          // An installment is a card installment, so a non-card account cannot stay chosen.
                          account_id: plan === 'installment' && !cardAccounts.some((a) => a.id === form.account_id) ? 0 : form.account_id,
                        })
                      }
                      segmentClassName="px-4 py-2 text-sm"
                    />
                  </div>
                  {isInstallment && (
                    <div>
                      <label className="label" htmlFor="wishlist-months">Months</label>
                      <input
                        id="wishlist-months"
                        type="number"
                        inputMode="numeric"
                        step="1"
                        min={MONTHS_MIN}
                        max={MONTHS_MAX}
                        value={form.installment_months}
                        onChange={(e) => setForm({ ...form, installment_months: e.target.value })}
                        className="input-field focus-ring"
                        placeholder={`${MONTHS_MIN} to ${MONTHS_MAX}`}
                        required
                      />
                    </div>
                  )}
                  {paymentLocked && (
                    <p className="text-sm text-muted">This item's card installment was created, so its price, currency and payment are fixed here. Change the installment in Recurring instead.</p>
                  )}
                </fieldset>
                <div>
                  <label className="label">Link (optional)</label>
                  <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input-field focus-ring" placeholder="https://..." />
                </div>
                <div>
                  <label className="label">Notes (optional)</label>
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="input-field focus-ring resize-none" rows={2} placeholder="Any details" />
                </div>
                {saveError && <p role="alert" className="text-sm text-danger" data-testid="wishlist-save-error">{saveError}</p>}
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


interface WishlistCardProps {
  item: WishlistItem
  accountName?: string
  /** Why marking the item purchased was refused, when it was. */
  error: string | null
  onCreateAllocationFromItem?: WishlistPanelProps['onCreateAllocationFromItem']
  onTogglePurchased: (item: WishlistItem) => void
  onEdit: (item: WishlistItem) => void
  onDelete: (item: WishlistItem) => void
}

/**
 * One wishlist row. Its outlook (`GET /wishlist/:id/outlook`) is one cached request per item, shared by the
 * badges, the installment line and the detail; a wishlist is a handful of items, so the list makes a handful of calls.
 */
function WishlistCard({ item, accountName, error, onCreateAllocationFromItem, onTogglePurchased, onEdit, onDelete }: WishlistCardProps) {
  const [showOutlook, setShowOutlook] = useState(false)
  // Asked for only where it is shown: an unpurchased item's badges and line, or the detail the user opened. A purchased
  // item makes no request until its detail is opened.
  const { data: outlook } = useGetWishlistOutlookQuery(item.id, { skip: item.is_purchased && !showOutlook })
  const isInstallment = item.payment_plan === 'installment'
  const currency = item.currency as CurrencyCode
  // The outlook's own figure when it is loaded, else the same split worked out here: no request for it.
  const monthly = outlook?.monthly_amount ?? monthlyAmountOf(item)
  // A purchased item's checks compare nothing more (its installment already counts), so they are not badged.
  const budget = outlook && !item.is_purchased ? BUDGET_BADGE[outlook.disposable_check.status] : null
  const card = outlook?.credit_check && !item.is_purchased ? CARD_BADGE[outlook.credit_check.status] : null
  const outlookId = `wishlist-outlook-${item.id}`

  return (
    <article className={`card p-4 sm:p-5 ${item.is_purchased ? 'opacity-60' : ''}`} data-testid={`wishlist-item-${item.id}`}>
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
            {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-ink hover:underline">Link <Icon name="external-link" /></a>}
            {item.is_purchased && item.purchased_at && <span className="inline-flex items-center rounded-full px-2 py-1 text-ok">Bought {longDate(item.purchased_at)}</span>}
          </div>
          {isInstallment && (
            <p className="text-sm text-body mt-2" data-testid="installment-line">
              {monthly != null && item.installment_months != null
                ? installmentLine(monthly, currency, item.installment_months)
                : `${item.installment_months ?? ''} months`}
              {accountName && <span className="text-muted"> · {accountName}</span>}
            </p>
          )}
          {(budget || card) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {budget && outlook && (
                <StatusText tone={budget.tone} title={outlook.disposable_check.reason ?? undefined} data-testid="budget-badge">{budget.text}</StatusText>
              )}
              {card && outlook?.credit_check && (
                <StatusText tone={card.tone} title={outlook.credit_check.reason ?? undefined} data-testid="card-badge">{card.text}</StatusText>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-danger mt-2" data-testid="purchase-error">{error}</p>}
          {isInstallment && (
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => setShowOutlook((v) => !v)}
                aria-expanded={showOutlook}
                aria-controls={outlookId}
                className="gap-1 px-3 py-0.5 text-xs"
              >
                {showOutlook ? 'Hide outlook' : 'Show outlook'}
              </Button>
              {showOutlook && (outlook ? <InstallmentOutlook id={outlookId} outlook={outlook} /> : <p className="text-xs text-muted mt-2">Loading the outlook…</p>)}
            </div>
          )}
          {onCreateAllocationFromItem && !item.is_purchased && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => onCreateAllocationFromItem(item, 'savings')}
                className="gap-1 px-3 py-0.5 text-xs"
              >
                <Icon name="savings" />
                Savings target
              </Button>
              <Button
                variant="secondary"
                onClick={() => onCreateAllocationFromItem(item, 'budget')}
                className="gap-1 px-3 py-0.5 text-xs"
              >
                <Icon name="budget" />
                Budget envelope
              </Button>
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-lg font-bold text-ink">{formatCurrency(item.estimated_cost, currency)}</p>
          <div className="mt-2 flex items-center justify-end gap-1">
            <Button variant="quiet" onClick={() => onTogglePurchased(item)} title={item.is_purchased ? 'Mark as not purchased' : 'Mark as purchased'} aria-label={item.is_purchased ? 'Mark as not purchased' : 'Mark as purchased'} className={ICON_ACTION}>
              <Icon name="check" />
            </Button>
            <Button variant="quiet" onClick={() => onEdit(item)} title="Edit" aria-label="Edit" className={ICON_ACTION}>
              <Icon name="edit" />
            </Button>
            <Button variant="danger" onClick={() => onDelete(item)} title="Delete" aria-label="Delete" className={ICON_ACTION}>
              <Icon name="delete" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  )
}

/**
 * Month by month, in the item's currency: the card installments already running, this item's payment, and what is
 * left of the item's rate (the outlook's `available`: net flow for an urgent need, free flow for a want) after this
 * item. Nothing shows when the item has no rate (`available` is null) or its payment that month is unknown.
 */
function InstallmentOutlook({ id, outlook }: { id: string; outlook: WishlistOutlook }) {
  const currency = outlook.currency as CurrencyCode
  const available = outlook.disposable_check.available
  const money = (n: number | null | undefined) => (n == null ? '—' : formatCurrency(n, currency))
  const left = (thisItem: number | null) => (available == null || thisItem == null ? null : available - thisItem)
  return (
    <section id={id} className="mt-3" aria-labelledby={`${id}-heading`} data-testid="installment-outlook">
      <h4 id={`${id}-heading`} className="text-sm font-semibold text-ink">Installment outlook</h4>
      <div className="overflow-x-auto mt-2">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">Month</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">Existing installments</th>
              <th scope="col" className="py-1 pr-3 font-medium text-right">This item</th>
              <th scope="col" className="py-1 font-medium text-right">Left each month after this item</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/50">
            {outlook.months.map((m) => (
              <tr key={m.month} data-testid={`outlook-month-${m.month}`}>
                <th scope="row" className="py-1 pr-3 font-normal text-body whitespace-nowrap">{monthLabel(m.month)}</th>
                <td className="py-1 pr-3 text-right text-body">{money(m.existing_installments)}</td>
                <td className="py-1 pr-3 text-right text-body">{money(m.this_item)}</td>
                <td className={`py-1 text-right ${left(m.this_item) != null && (left(m.this_item) ?? 0) < 0 ? 'text-danger' : 'text-ink'}`}>{money(left(m.this_item))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(outlook.note || outlook.disposable_check.reason) && (
        <p className="text-xs text-muted mt-2">{[outlook.note, outlook.disposable_check.reason].filter(Boolean).join(' ')}</p>
      )}
    </section>
  )
}

/** One currency's three monthly figures, or why there are none, and what the figures rest on. */
function FlowSummary({ row, showCurrency }: { row: WishlistFreeFlowRow; showCurrency: boolean }) {
  const currency = row.currency as CurrencyCode
  const money = (n: number | null) => (n == null ? '—' : formatCurrency(n, currency))
  const sample = sampleNote(row.sample_months)
  const status =
    row.status === 'not_estimated' ? NOT_ESTIMATED_TEXT
    : row.status === 'incomplete' ? INCOMPLETE_TEXT
    : row.status === 'no_projection' ? noProjectionText(row.currency)
    : null
  const shortfall = row.status === 'ok' && row.shortfall != null && row.shortfall > 0 ? row.shortfall : null
  return (
    <div className="space-y-2" data-testid={`flow-${row.currency}`}>
      {showCurrency && <p className="text-xs font-semibold text-muted">{row.currency}</p>}
      {row.status === 'ok' ? (
        <dl className="grid grid-cols-1 sm:grid-cols-3 border border-line divide-y sm:divide-y-0 sm:divide-x divide-line">
          <div className="px-4 py-3" data-testid="flow-net">
            <dt className="text-sm text-muted">Net flow</dt>
            <dd className="text-xl font-semibold text-ink">{money(row.net_flow)}</dd>
            <p className="text-xs text-muted">Income less spending</p>
          </div>
          <div className="px-4 py-3" data-testid="flow-kept">
            <dt className="text-sm text-muted">Kept for saving</dt>
            <dd className="text-xl font-semibold text-ink">{money(row.reserved)}</dd>
            <p className="text-xs text-muted">Saved and needed by your goals</p>
          </div>
          <div className="px-4 py-3" data-testid="flow-free">
            <dt className="text-sm text-muted">Free for the wishlist</dt>
            <dd className="text-xl font-semibold text-ink">{money(row.free_flow)}</dd>
            <p className="text-xs text-muted">What is left over</p>
          </div>
        </dl>
      ) : (
        status && <p className="text-sm text-warn" data-testid="flow-status">{status}</p>
      )}
      {shortfall != null && (
        <p className="text-sm text-warn" data-testid="flow-shortfall">
          Your savings goals are short by {formatCurrency(shortfall, currency)} a month, so nothing is free for the wishlist.
        </p>
      )}
      {sample && <p className="text-sm text-muted" data-testid="flow-sample">{sample}</p>}
    </div>
  )
}

/** A queued item's date, or the note that stands in for it: its own, else the queue's. */
function PlanWhen({ item, defaultCurrency }: { item: WishlistPlanItem; defaultCurrency: CurrencyCode }) {
  const currency = (item.currency ?? defaultCurrency) as CurrencyCode
  // Only a `dated` item has a date; a status the API did not send is read as the older answer, which dated by the field alone.
  const date = !item.projection_status || item.projection_status === 'dated' ? item.estimated_purchase_date : null
  const note = item.note ?? item.projection_note ?? item.queue_note
  return (
    <div className="text-right flex-shrink-0">
      <p className="text-sm font-semibold text-ink" data-testid="plan-cost">{formatCurrency(item.estimated_cost, currency)}</p>
      {date
        ? <p className="text-xs text-muted" data-testid="plan-date">~{longDate(date)} · {item.cumulative_months} mo</p>
        : <p className="text-xs text-warn" data-testid="plan-note">{note ?? 'No date yet'}</p>}
    </div>
  )
}

/** An urgent need: its date or note, and what buying it does to this month's net flow and to saving. */
function UrgentRow({ item, row, defaultCurrency }: { item: WishlistPlanItem; row: WishlistFreeFlowRow | undefined; defaultCurrency: CurrencyCode }) {
  const currency = (item.currency ?? defaultCurrency) as CurrencyCode
  const before = row?.status === 'ok' ? row.net_flow : null
  return (
    <li className="border border-line p-4 space-y-3" data-testid={`plan-item-${item.item_id}`}>
      <div className="flex items-start justify-between gap-4">
        <span className="font-medium text-ink">{item.name}</span>
        <PlanWhen item={item} defaultCurrency={defaultCurrency} />
      </div>
      {(item.net_flow_after != null || item.from_saving != null) && (
        <div className="border-t border-line pt-3 space-y-1 text-sm text-warn">
          {item.net_flow_after != null && (
            <p data-testid="plan-net-flow-after">
              Net flow the month you buy it: {formatCurrency(item.net_flow_after, currency)}
              {before != null && ` instead of ${formatCurrency(before, currency)}`}
            </p>
          )}
          {item.from_saving != null && (
            <p data-testid="plan-from-saving">
              {item.from_saving > 0 ? `About ${formatCurrency(item.from_saving, currency)} of it comes out of saving` : 'None of it comes out of saving'}
            </p>
          )}
        </div>
      )}
    </li>
  )
}
