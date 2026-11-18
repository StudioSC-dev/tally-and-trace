import type { FxMeta } from '@tally-trace/shared'
import { fxAttribution } from '../utils/fx'
import { Icon } from './Icon'

/** The unconverted banner (when rows have no stored rate) and the rate attribution. */
export function FxNotice({ fx }: { fx: FxMeta | undefined }) {
  if (!fx) return null
  const attribution = fxAttribution(fx)
  if (fx.unconverted_count === 0 && !attribution) return null
  return (
    <div className="space-y-2" data-testid="fx-notice">
      {fx.unconverted_count > 0 && (
        <div className="flex items-start gap-3 border border-warn p-3 text-warn" role="status" data-testid="unconverted-banner">
          <Icon name="warning" />
          <p className="text-sm text-warn">
            {fx.unconverted_count === 1 ? '1 item could not be converted (no exchange rate yet); it is not in these totals.' : `${fx.unconverted_count} items could not be converted (no exchange rate yet); they are not in these totals.`}
          </p>
        </div>
      )}
      {attribution && <p className="text-xs text-muted" data-testid="fx-attribution">{attribution}</p>}
    </div>
  )
}
