// Type-level checks, compiled by `pnpm build` (`tsc --noEmit`); vitest does not run this file.
import type { CashflowTimelineEvent } from './api'

// STU-306, timeline_event_rejects_unconverted: the timeline never sends `unconverted`,
// so a timeline event cannot carry it. The estimate labels it does send still type-check.
const estimated: CashflowTimelineEvent = {
  date: '2026-11-05', name: 'Rent', amount: -500, type: 'expense', source: 'budget_entry',
  source_id: 7, event_id: 'e1', running_balance: 100, currency: 'PHP',
  estimated: true, original_amount: 10, original_currency: 'USD', rate: 50,
  rate_as_of: '2026-11-01', rate_stale: false,
}

const unconverted: CashflowTimelineEvent = {
  ...estimated,
  // @ts-expect-error `unconverted` is not a timeline event key
  unconverted: true,
}

export const timelineEventChecks = [estimated, unconverted]
