import { useMemo, useId } from 'react'
import type { CashflowTimeline } from '../store/api'

interface Props {
  timeline: CashflowTimeline
  format: (n: number) => string
  height?: number
  compact?: boolean
}

const W = 720
const BLUE = '#3b82f6'
const ROSE = '#e11d48'
const AMBER = '#f59e0b'

const shortDate = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d)
}

/**
 * Single-series running-balance line: the app's cash on hand walked in date
 * order, with a zero baseline (the solvency threshold), a shaded danger zone
 * below it, and a labelled trough. No legend — one series, named by the title.
 */
export function RunningBalanceChart({ timeline, format, height = 280, compact = false }: Props) {
  const gradId = useId()
  const H = height
  const padL = compact ? 14 : 60
  const padR = compact ? 14 : 26
  const padT = 16
  const padB = compact ? 22 : 34

  const geom = useMemo(() => {
    const startT = new Date(timeline.window_start).getTime()
    const endT = new Date(timeline.window_end).getTime()
    const span = Math.max(endT - startT, 1)

    const pts = [
      { t: startT, v: timeline.opening_balance, name: 'Opening', date: timeline.window_start },
      ...timeline.events.map((e) => ({ t: new Date(e.date).getTime(), v: e.running_balance, name: e.name, date: e.date })),
    ]

    const values = pts.map((p) => p.v)
    let yMin = Math.min(0, ...values)
    let yMax = Math.max(0, ...values)
    if (yMin === yMax) { yMax += 1; yMin -= 1 }
    const headroom = (yMax - yMin) * 0.08
    yMin -= headroom
    yMax += headroom

    const fx = (t: number) => padL + ((t - startT) / span) * (W - padL - padR)
    const fy = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB)

    const coords = pts.map((p) => ({ x: fx(p.t), y: fy(p.v), v: p.v, name: p.name, date: p.date }))
    const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
    const last = coords[coords.length - 1]
    const first = coords[0]
    const baseY = fy(yMin)
    const area = `${line} L${last.x.toFixed(1)},${baseY.toFixed(1)} L${first.x.toFixed(1)},${baseY.toFixed(1)} Z`
    const zeroY = fy(0)
    const troughIdx = coords.reduce((lo, c, i) => (c.v < coords[lo].v ? i : lo), 0)

    return { coords, line, area, zeroY, trough: coords[troughIdx] }
  }, [timeline, H, padL, padR, padT, padB])

  const negative = timeline.lowest_balance < 0
  const troughColor = negative ? ROSE : AMBER
  const dangerH = Math.max(0, H - padB - geom.zeroY)

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Projected running balance from ${timeline.window_start} to ${timeline.window_end}. Lowest ${format(timeline.lowest_balance)}${timeline.trough_date ? ` on ${timeline.trough_date}` : ''}.`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={BLUE} stopOpacity={0.22} />
          <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
        </linearGradient>
      </defs>

      {/* Danger zone: anything below the zero line is a shortfall */}
      {dangerH > 0 && (
        <rect x={padL} y={geom.zeroY} width={W - padL - padR} height={dangerH} fill={ROSE} opacity={0.06} />
      )}

      {/* Zero baseline */}
      <line
        x1={padL} x2={W - padR} y1={geom.zeroY} y2={geom.zeroY}
        className="text-gray-400 dark:text-slate-600" stroke="currentColor" strokeWidth={1} strokeDasharray="4 4"
      />
      {!compact && (
        <text x={padL - 8} y={geom.zeroY + 3} textAnchor="end" fontSize={11}
          className="text-gray-400 dark:text-slate-500" fill="currentColor">0</text>
      )}

      {/* Area + line */}
      <path d={geom.area} fill={`url(#${gradId})`} />
      <path d={geom.line} fill="none" stroke={BLUE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {/* Event points (rose when the balance is negative there) */}
      {geom.coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={i === 0 ? 3 : 3.2}
          fill={c.v < 0 ? ROSE : BLUE}
          className="stroke-white dark:stroke-slate-900" strokeWidth={1.5} />
      ))}

      {/* Trough marker + direct label */}
      <circle cx={geom.trough.x} cy={geom.trough.y} r={5.5} fill="none" stroke={troughColor} strokeWidth={2} />
      {!compact && (
        <text
          x={Math.min(Math.max(geom.trough.x, padL + 40), W - padR - 40)}
          y={geom.trough.y > geom.zeroY ? geom.trough.y + 18 : geom.trough.y - 10}
          textAnchor="middle" fontSize={11} fontWeight={600}
          style={{ fill: troughColor }}
        >
          Low {format(timeline.lowest_balance)}{timeline.trough_date ? ` · ${shortDate(timeline.trough_date)}` : ''}
        </text>
      )}

      {/* X-axis endpoints */}
      {!compact && (
        <>
          <text x={padL} y={H - 8} fontSize={11} textAnchor="start"
            className="text-gray-400 dark:text-slate-500" fill="currentColor">{shortDate(timeline.window_start)}</text>
          <text x={W - padR} y={H - 8} fontSize={11} textAnchor="end"
            className="text-gray-400 dark:text-slate-500" fill="currentColor">{shortDate(timeline.window_end)}</text>
        </>
      )}
    </svg>
  )
}
