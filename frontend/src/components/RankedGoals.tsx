import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import type { Allocation, WishlistFreeFlow, WishlistFreeFlowGoal } from '@tally-trace/shared'
import { useGetRankedAllocationsQuery, useGetWishlistFreeFlowQuery, useReorderRankedAllocationsMutation } from '../store/api'
import { useToast } from '../hooks/useToast'
import { apiErrorMessage } from '../utils/apiError'
import { formatCurrency } from '../utils/currency'
import type { CurrencyCode } from '../utils/currency'
import { Button } from './Button'
import { Icon } from './Icon'
import { StatusText } from './StatusText'

/**
 * One shared mutation entry for every reorder, so the "saving" state outlives the component: a tab switch unmounts
 * the section while a reorder is in flight, and the section that comes back still sees it and sends no second one.
 */
const REORDER_KEY = 'ranked-allocations-reorder'

/**
 * A drag in progress: the goal held and the place it would drop into. The goal is held by its id, never by the place
 * it started from: the ranked list can refresh mid-drag, and its places move.
 */
interface Drag {
  id: number
  over: number
}

/** `items` with the one at `from` taken out and put at `to`. */
function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Why no pace shows, by the free-flow rows' status: the caller-wide statuses `not_estimated` and `incomplete` (STU-788). */
const NOT_ESTIMATED_NOTE = 'Monthly pace shows once you have one full month of history.'
const INCOMPLETE_NOTE = 'Money in more than one currency is involved, so this cannot be estimated yet.'
const unreservedNote = (currency: string): string =>
  `A goal needs saving in ${currency}, but there is no ${currency} income to reserve it from, so this cannot be estimated yet.`

/**
 * The note for the whole section, or null when the rows hold figures. Both statuses are set for every row at once.
 * `incomplete` has more than one cause (STU-788): money or goals in two currencies, or a top-up in a currency with no
 * income, which marks the goal `unreserved`. With a single currency row and an unreserved goal the second is the only
 * cause the response states, so the note says that rather than naming a second currency.
 */
function noteFor(flow: WishlistFreeFlow | undefined): string | null {
  if (!flow) return null
  if (flow.rows.some((row) => row.status === 'incomplete')) {
    const only = flow.rows.length === 1 ? flow.rows[0] : undefined
    if (only && flow.goals.some((goal) => goal.unreserved)) return unreservedNote(only.currency)
    return INCOMPLETE_NOTE
  }
  if (flow.rows.some((row) => row.status === 'not_estimated')) return NOT_ESTIMATED_NOTE
  return null
}

/**
 * A goal's monthly pace, its underfunded flag and its overdue and unreserved labels, as the API decided them. The
 * pace and the flag are null for a caller with no estimate, and then only the labels can show.
 */
function GoalFlow({ goal }: { goal: WishlistFreeFlowGoal }) {
  const currency = goal.currency as CurrencyCode
  const uncovered = goal.underfunded !== null && goal.underfunded > 0 ? goal.underfunded : null
  if (goal.pace === null && !goal.overdue && !goal.unreserved) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-sm" data-testid="ranked-goal-flow">
      {goal.pace !== null && (
        <span className="text-body" data-testid="ranked-goal-pace">
          {goal.pace > 0 ? `Needs ${formatCurrency(goal.pace, currency)} a month` : 'No monthly saving needed'}
        </span>
      )}
      {uncovered !== null && (
        <StatusText tone="warn" data-testid="ranked-goal-underfunded">
          Underfunded by {formatCurrency(uncovered, currency)} a month
        </StatusText>
      )}
      {goal.overdue && (
        <StatusText tone="danger" data-testid="ranked-goal-overdue">
          Overdue
        </StatusText>
      )}
      {goal.unreserved && (
        <StatusText tone="warn" data-testid="ranked-goal-unreserved">
          Unreserved
        </StatusText>
      )}
    </div>
  )
}

/**
 * The "Savings goals" section (STU-787): the user's ranked goals in rank order, top first. The order decides which
 * goal gives way first when money is short. A goal moves by dragging its handle (native pointer events) or by its
 * move-up and move-down buttons, which a keyboard reaches. Every reorder sends the complete list; a refused one
 * puts the old order back and shows the reason in the toast.
 */
export function RankedGoals({ renderCard }: { renderCard: (goal: Allocation) => ReactNode }) {
  const { data, isLoading, isError, refetch } = useGetRankedAllocationsQuery()
  const [reorder, { isLoading: isSaving }] = useReorderRankedAllocationsMutation({ fixedCacheKey: REORDER_KEY })
  const showToast = useToast()
  const goals = data?.items
  const { data: flow } = useGetWishlistFreeFlowQuery()
  const flowByGoal = useMemo(() => new Map((flow?.goals ?? []).map((entry) => [entry.allocation_id, entry])), [flow])
  const flowNote = noteFor(flow)

  const rowRefs = useRef(new Map<number, HTMLLIElement>())
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const updateDrag = useCallback((next: Drag | null) => {
    dragRef.current = next
    setDrag(next)
  }, [])
  // The button to give focus back to once the list has re-sorted, so a keyboard user can press it again.
  const refocus = useRef<{ id: number; direction: 'up' | 'down' } | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  useLayoutEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    listRef.current?.querySelector<HTMLElement>(`[data-goal-id="${target.id}"] [data-move="${target.direction}"]`)?.focus()
  }, [goals])

  const send = useCallback(
    async (from: number, to: number, direction?: 'up' | 'down') => {
      if (!goals || isSaving || from === to || to < 0 || to >= goals.length) return
      const id = goals[from].id
      if (direction) refocus.current = { id, direction }
      try {
        await reorder(moved(goals, from, to).map((goal) => goal.id)).unwrap()
      } catch (error) {
        showToast(apiErrorMessage(error) || 'Could not save the new order. Please try again.')
        if (direction) refocus.current = { id, direction }
      }
    },
    [goals, isSaving, reorder, showToast],
  )

  // The place a goal held from `from` would take if dropped with the pointer at `y`: the pointer sits between two
  // rows (a slot), and the goal lands where that slot is once the goal itself has left its old place.
  const overAt = (y: number, from: number): number => {
    if (!goals) return from
    let slot = 0
    for (const goal of goals) {
      const row = rowRefs.current.get(goal.id)
      if (!row) continue
      const box = row.getBoundingClientRect()
      if (y > box.top + box.height / 2) slot += 1
    }
    return slot > from ? slot - 1 : slot
  }

  const startDrag = (event: PointerEvent<HTMLElement>, index: number) => {
    if (!goals || isSaving || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    updateDrag({ id: goals[index].id, over: index })
  }
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (!current || !goals) return
    const from = goals.findIndex((goal) => goal.id === current.id)
    if (from < 0) return
    const over = overAt(event.clientY, from)
    if (over !== current.over) updateDrag({ ...current, over })
  }
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const current = dragRef.current
    if (!current) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    updateDrag(null)
    // Where the goal is now, and where the pointer is now: the list may have changed since the pick-up.
    const from = goals?.findIndex((goal) => goal.id === current.id) ?? -1
    if (from >= 0) void send(from, overAt(event.clientY, from))
  }
  const cancelDrag = () => updateDrag(null)
  // Escape drops a drag without moving anything.
  const isDragging = drag !== null
  useEffect(() => {
    if (!isDragging) return undefined
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') updateDrag(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDragging, updateDrag])

  return (
    <section className="space-y-3" data-testid="ranked-goals">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold text-ink">Savings goals</h2>
        <p className="text-sm text-muted">
          Put your goals in order. When money is short, the goal at the bottom gives way first.
        </p>
      </header>
      {flowNote && (
        <p className="text-sm text-muted" data-testid="ranked-goals-flow-note">
          {flowNote}
        </p>
      )}
      {isError && (
        <div className="card p-4 space-y-3" role="alert" data-testid="ranked-goals-error">
          <p className="text-sm text-danger">Could not load your savings goals.</p>
          <Button variant="secondary" data-testid="ranked-goals-retry" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}
      {isLoading && <p className="text-sm text-muted">Loading savings goals...</p>}
      {goals && goals.length === 0 && (
        <p className="text-sm text-muted" data-testid="ranked-goals-empty">
          No ranked savings goals yet. A new savings goal joins here, at the bottom.
        </p>
      )}
      {goals && goals.length > 0 && (
        <ul ref={listRef} className="grid grid-cols-1 gap-3" data-testid="ranked-goals-list" aria-label="Savings goals, top first">
          {goals.map((goal, index) => {
            const goalFlow = flowByGoal.get(goal.id)
            const isHeld = drag?.id === goal.id
            const isTarget = drag !== null && drag.over === index && drag.id !== goal.id
            return (
              <li
                key={goal.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(goal.id, node)
                  else rowRefs.current.delete(goal.id)
                }}
                data-testid="ranked-goal"
                data-goal-id={goal.id}
                data-rank={index + 1}
                data-dragging={isHeld ? 'true' : undefined}
                data-drop-target={isTarget ? 'true' : undefined}
                className={`flex items-stretch gap-2 ${isHeld ? 'opacity-60' : ''} ${isTarget ? 'outline outline-2 outline-ink' : ''}`}
              >
                <div className="flex shrink-0 flex-col items-center justify-center gap-1">
                  <span className="text-xs font-medium text-muted" data-testid="ranked-goal-position">
                    {index + 1}
                  </span>
                  <Button
                    variant="quiet"
                    aria-label={`Move ${goal.name} up`}
                    aria-disabled={index === 0 || isSaving || undefined}
                    data-move="up"
                    data-testid="ranked-goal-up"
                    className="min-h-11 min-w-11 px-2"
                    onClick={() => void send(index, index - 1, 'up')}
                  >
                    <Icon name="caret-up" />
                  </Button>
                  <span
                    aria-hidden="true"
                    aria-disabled={isSaving || undefined}
                    data-testid="ranked-goal-handle"
                    title="Drag to reorder"
                    className={`inline-flex min-h-11 min-w-11 touch-none select-none items-center justify-center text-muted ${isSaving ? 'cursor-not-allowed opacity-50' : 'cursor-grab active:cursor-grabbing'}`}
                    onPointerDown={(event) => startDrag(event, index)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  >
                    <Icon name="drag-handle" />
                  </span>
                  <Button
                    variant="quiet"
                    aria-label={`Move ${goal.name} down`}
                    aria-disabled={index === goals.length - 1 || isSaving || undefined}
                    data-move="down"
                    data-testid="ranked-goal-down"
                    className="min-h-11 min-w-11 px-2"
                    onClick={() => void send(index, index + 1, 'down')}
                  >
                    <Icon name="caret-down" />
                  </Button>
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  {renderCard(goal)}
                  {goalFlow && <GoalFlow goal={goalFlow} />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
