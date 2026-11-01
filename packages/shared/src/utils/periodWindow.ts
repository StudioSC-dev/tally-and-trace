import { addDays, dayEndWire, dayStartWire } from './transactionList'

export type DashboardPeriod = 'week' | 'month' | 'year'

/**
 * The dashboard's period summary bounds, as wire values, for the calendar day `today`
 * (`YYYY-MM-DD`, Manila's day). Record dates are days, so the window runs from the start
 * of its first day to the end of `today`, never to the current instant: a row dated
 * today stays inside it at any hour. A week is the last 7 days including today.
 */
export function periodWindow(period: DashboardPeriod, today: string): { start_date: string; end_date: string } {
  let startDay: string
  switch (period) {
    case 'week': startDay = addDays(today, -6); break
    case 'month': startDay = `${today.slice(0, 7)}-01`; break
    case 'year': startDay = `${today.slice(0, 4)}-01-01`; break
  }
  return { start_date: dayStartWire(startDay), end_date: dayEndWire(today) }
}
