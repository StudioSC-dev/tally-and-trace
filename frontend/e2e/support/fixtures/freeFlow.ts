/**
 * The `GET /wishlist/free-flow` answers for the goal pace and underfunded flag specs (STU-790).
 *
 * Made-up figures for the household's ranked goals (`rankedGoals(household.allocations)`): Emergency fund (61), Japan trip
 * (62, which `withDollarGoal` puts in dollars), New laptop (63), Christmas gifts (64) and Car maintenance (68), in that rank
 * order. Each scenario is what the API would answer for one state of the caller; the specs register one with `apiRoute`
 * or `sequenceRoute`. Nothing here works out which goal gives way: the answer carries it, as the API's does.
 */
import type { WishlistFreeFlow, WishlistFreeFlowGoal, WishlistFreeFlowRow } from '@tally-trace/shared'
import type { HouseholdData } from './household'

/** The default answer: no rows and no goals, so no pace, flag or note shows. */
export const NO_FREE_FLOW: WishlistFreeFlow = { rows: [], goals: [], limitations: [] }

export const GOAL_IDS = { emergency: 61, japan: 62, laptop: 63, gifts: 64, car: 68 } as const

/** The household with the Japan trip goal kept in dollars, so the section holds a goal in a second currency. */
export const withDollarGoal = (data: HouseholdData): HouseholdData => ({
  ...data,
  allocations: data.allocations.map((a) => (a.id === GOAL_IDS.japan ? { ...a, currency: 'USD' as const } : a)),
})

const goal = (id: number, rank: number, currency: string, over: Partial<WishlistFreeFlowGoal> = {}): WishlistFreeFlowGoal => ({
  allocation_id: id,
  rank,
  currency,
  pace: 0,
  fed: 0,
  top_up: 0,
  underfunded: 0,
  unreserved: false,
  overdue: false,
  ...over,
})

const row = (currency: string, over: Partial<WishlistFreeFlowRow> = {}): WishlistFreeFlowRow => ({
  currency,
  status: 'ok',
  sample_months: 6,
  income: 60000,
  spending: 25000,
  debt_paid: 4500,
  saved: 14000,
  net_flow: 30500,
  goal_top_up: 20500,
  reserved: 34500,
  free_flow: 0,
  shortfall: 4000,
  ...over,
})

/** An `ok` caller with PHP and USD rows. The PHP row is `shortfall` short; the dollars are covered. */
const okFlow = (goals: WishlistFreeFlowGoal[], shortfall: number): WishlistFreeFlow => ({
  rows: [
    row('PHP', { shortfall, net_flow: 14000 + 20500 - shortfall }),
    row('USD', { income: 1500, spending: 600, debt_paid: 0, saved: 100, net_flow: 900, goal_top_up: 700, reserved: 800, free_flow: 0, shortfall: 0 }),
  ],
  goals,
  limitations: ['It is a plain average. A one-off windfall raises it and a one-off large purchase lowers it for up to 12 months.'],
})

/**
 * Goals in rank order Emergency, Japan, Laptop, Gifts, Car. The top-ups are 10,000 for Emergency, 6,000 for the laptop,
 * 2,000 for gifts and 2,500 for the car, in pesos, and 700 for the Japan trip, in dollars (always covered).
 */
const paces = { emergency: 10000, japan: 800, laptop: 6000, gifts: 2000, car: 2500 }

/** Every goal covered: no flag anywhere. */
export const COVERED: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: paces.emergency, top_up: 10000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: paces.laptop, top_up: 6000 }),
    goal(GOAL_IDS.gifts, 4, 'PHP', { pace: paces.gifts, top_up: 2000 }),
    goal(GOAL_IDS.car, 5, 'PHP', { pace: paces.car, top_up: 2500 }),
  ],
  0,
)

/** 500 pesos short: only the lowest-ranked goal, the car, gives way. */
export const SHORT_BY_500: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: paces.emergency, top_up: 10000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: paces.laptop, top_up: 6000 }),
    goal(GOAL_IDS.gifts, 4, 'PHP', { pace: paces.gifts, top_up: 2000 }),
    goal(GOAL_IDS.car, 5, 'PHP', { pace: paces.car, top_up: 2500, underfunded: 500 }),
  ],
  500,
)

/** 4,000 pesos short: the car gives way in full and the gifts in part. */
export const SHORT_BY_4000: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: paces.emergency, top_up: 10000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: paces.laptop, top_up: 6000 }),
    goal(GOAL_IDS.gifts, 4, 'PHP', { pace: paces.gifts, top_up: 2000, underfunded: 1500 }),
    goal(GOAL_IDS.car, 5, 'PHP', { pace: paces.car, top_up: 2500, underfunded: 2500 }),
  ],
  4000,
)

/** The 4,000 shortfall after the car is moved up one place: now the gifts are lowest, and the car is next. */
export const SHORT_BY_4000_CAR_UP: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: paces.emergency, top_up: 10000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: paces.laptop, top_up: 6000 }),
    goal(GOAL_IDS.car, 4, 'PHP', { pace: paces.car, top_up: 2500, underfunded: 2000 }),
    goal(GOAL_IDS.gifts, 5, 'PHP', { pace: paces.gifts, top_up: 2000, underfunded: 2000 }),
  ],
  4000,
)

/** After an allocation write lowered the Emergency fund's monthly target to 9,000 (the car moved up, as above). */
export const AFTER_EMERGENCY_TARGET_CUT: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: 9000, top_up: 9000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: paces.laptop, top_up: 6000 }),
    goal(GOAL_IDS.car, 4, 'PHP', { pace: paces.car, top_up: 2500, underfunded: 1000 }),
    goal(GOAL_IDS.gifts, 5, 'PHP', { pace: paces.gifts, top_up: 2000, underfunded: 2000 }),
  ],
  3000,
)

/** The laptop's target date has passed, so it reserves everything it still needs: it is overdue. */
export const WITH_OVERDUE: WishlistFreeFlow = okFlow(
  [
    goal(GOAL_IDS.emergency, 1, 'PHP', { pace: paces.emergency, top_up: 10000 }),
    goal(GOAL_IDS.japan, 2, 'USD', { pace: paces.japan, top_up: 700 }),
    goal(GOAL_IDS.laptop, 3, 'PHP', { pace: 43200, top_up: 43200, overdue: true }),
    goal(GOAL_IDS.gifts, 4, 'PHP', { pace: paces.gifts, top_up: 2000 }),
    goal(GOAL_IDS.car, 5, 'PHP', { pace: paces.car, top_up: 2500 }),
  ],
  0,
)

const NO_FIGURES = { pace: null, fed: null, top_up: null, underfunded: null }

/**
 * A caller with money or goals in more than one currency: every row is `incomplete` and the figures of every goal are
 * null. The Japan trip, in dollars, has a top-up in a currency with no income, so it is unreserved.
 */
export const CROSS_CURRENCY: WishlistFreeFlow = {
  rows: [
    row('PHP', { status: 'incomplete', net_flow: null, goal_top_up: null, reserved: null, free_flow: null, shortfall: null }),
    row('USD', { status: 'incomplete', income: 0, spending: 0, debt_paid: 0, saved: 0, net_flow: null, goal_top_up: null, reserved: null, free_flow: null, shortfall: null }),
  ],
  goals: [
    goal(GOAL_IDS.emergency, 1, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.japan, 2, 'USD', { ...NO_FIGURES, unreserved: true }),
    goal(GOAL_IDS.laptop, 3, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.gifts, 4, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.car, 5, 'PHP', NO_FIGURES),
  ],
  limitations: [],
}

const NO_HISTORY: Partial<WishlistFreeFlowRow> = {
  status: 'not_estimated',
  sample_months: 0,
  income: null,
  spending: null,
  debt_paid: null,
  saved: null,
  net_flow: null,
  goal_top_up: null,
  reserved: null,
  free_flow: null,
  shortfall: null,
}

/** A user with no full month of history: every row is `not_estimated`, with no months sampled and no figures. */
export const NOT_ESTIMATED: WishlistFreeFlow = {
  rows: [row('PHP', NO_HISTORY), row('USD', NO_HISTORY)],
  goals: [
    goal(GOAL_IDS.emergency, 1, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.japan, 2, 'USD', NO_FIGURES),
    goal(GOAL_IDS.laptop, 3, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.gifts, 4, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.car, 5, 'PHP', NO_FIGURES),
  ],
  limitations: [],
}

/**
 * A caller whose only currency is pesos, with a goal that needs a top-up but no peso income to place it from: the Emergency
 * fund is unreserved and every row is `incomplete`, though no second currency is involved.
 */
export const PHP_ONLY_UNRESERVED: WishlistFreeFlow = {
  rows: [row('PHP', { status: 'incomplete', income: 0, net_flow: null, goal_top_up: null, reserved: null, free_flow: null, shortfall: null })],
  goals: [
    goal(GOAL_IDS.emergency, 1, 'PHP', { ...NO_FIGURES, unreserved: true }),
    goal(GOAL_IDS.japan, 2, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.laptop, 3, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.gifts, 4, 'PHP', NO_FIGURES),
    goal(GOAL_IDS.car, 5, 'PHP', NO_FIGURES),
  ],
  limitations: [],
}

/** The id of the goal the create scenario adds, "Wedding fund", a peso goal that joins at the bottom. */
export const NEW_GOAL_ID = 90

/** Each goal's monthly pace, for `flowForGoals`. */
const GOAL_PACES: Record<number, number> = {
  [GOAL_IDS.emergency]: 10000,
  [GOAL_IDS.japan]: 800,
  [GOAL_IDS.laptop]: 6000,
  [GOAL_IDS.gifts]: 2000,
  [GOAL_IDS.car]: 2500,
  [NEW_GOAL_ID]: 1500,
}

/** The pesos of net flow left for goals after what is already being saved, in `flowForGoals`. */
const PESOS_FOR_GOALS = 16500

/**
 * The free flow a stateful fake answers for the goals it currently holds, in rank order: the pesos for goals are given
 * out top down, so the lowest-ranked peso goal gives way first, as the API's answer does. It is the fake's stand-in
 * for the API (the page never works this out); dollar goals are always covered.
 */
export const flowForGoals = (held: { id: number; currency: string }[]): WishlistFreeFlow => {
  let left = PESOS_FOR_GOALS
  const goals = held.map(({ id, currency }, index) => {
    const pace = GOAL_PACES[id] ?? 0
    if (currency !== 'PHP') return goal(id, index + 1, currency, { pace, top_up: pace })
    const covered = Math.min(left, pace)
    left -= covered
    return goal(id, index + 1, currency, { pace, top_up: pace, underfunded: pace - covered })
  })
  const shortfall = goals.reduce((sum, g) => sum + (g.currency === 'PHP' ? (g.underfunded ?? 0) : 0), 0)
  return okFlow(goals, shortfall)
}
