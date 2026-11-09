// Dates for seeding card installments in the browser checks. The API stores a new card
// installment on its statement close (768a9b9), and a close day is at most the 28th, so a
// scenario that reads an installment's own date seeds it on a day it never has to clamp and
// closes its card on exactly that day.

const dom = (day) => Number(day.slice(8, 10))
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * The days `offsets` (in days, all at or after 0) after `today`, moved forward together by the
 * fewest days that leaves every one on the 28th or earlier. Their order and spacing stay as
 * given, so they are distinct and still ahead of `today`; most days of the month move nothing.
 */
function seedDays(today, offsets) {
  for (let shift = 0; shift <= 31; shift++) {
    const days = offsets.map((n) => addDays(today, n + shift))
    if (days.every((d) => dom(d) <= 28)) return days
  }
  throw new Error(`no run of days ${offsets.join(', ')} fits a close day`)
}

/** The close day that keeps an installment dated `day` where it is; `day` must be on the 28th or earlier. */
function closeDayOf(day) {
  if (dom(day) > 28) throw new Error(`${day} is past the 28th: a card cannot close on it`)
  return dom(day)
}

module.exports = { seedDays, closeDayOf }
