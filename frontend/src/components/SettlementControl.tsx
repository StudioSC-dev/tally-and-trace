import { useState } from 'react'
import { settlementReasonText } from '@tally-trace/shared'
import type { Settlement } from '@tally-trace/shared'
import { useGetEntryAutoPostPreviewQuery, useGetLoanAutoPostPreviewQuery } from '../store/api'
import { useAutopayActions } from '../hooks/useAutopayActions'
import type { AutopaySubject } from '../hooks/useAutopayActions'

/**
 * Autopay or manual for a cash entry or a loan, changed on its own (not with a Save). Turning
 * on asks the server first: a block is shown here in plain words and the button stays off; missed
 * payments are confirmed with their count and post on confirm; Cancel posts nothing. What it shows
 * after a change is the flag the server returned.
 */
export function SettlementControl({ subject, settlement }: { subject: AutopaySubject; settlement: Settlement }) {
  const { turnOn, turnOff } = useAutopayActions()
  // The flag the last change returned, trusted only while the prop it was made against has not moved on.
  const [seen, setSeen] = useState<{ from: Settlement; enabled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enabled = seen !== null && seen.from === settlement ? seen.enabled : settlement === 'autopay'

  // What turning it on would do, read while it is off so a block shows before anyone clicks.
  const skip = enabled
  const entryPreview = useGetEntryAutoPostPreviewQuery(subject.id, { skip: skip || subject.kind !== 'entry', refetchOnMountOrArgChange: true })
  const loanPreview = useGetLoanAutoPostPreviewQuery(subject.id, { skip: skip || subject.kind !== 'loan', refetchOnMountOrArgChange: true })
  const preview = subject.kind === 'entry' ? entryPreview.currentData : loanPreview.currentData
  const blockText = !enabled && preview?.block ? settlementReasonText(preview.block) : null

  const change = async () => {
    setBusy(true)
    setError(null)
    const outcome = await (enabled ? turnOff(subject) : turnOn(subject))
    setBusy(false)
    if (outcome.error !== null) setError(outcome.error)
    else if (outcome.enabled !== null) setSeen({ from: settlement, enabled: outcome.enabled })
  }

  return (
    <div className="space-y-2 border border-line p-4" data-testid="settlement-control" data-settlement={enabled ? 'autopay' : 'manual'}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Settlement</h3>
          <p className="text-sm text-body" data-testid="settlement-state">{enabled ? 'Autopay' : 'Manual'}</p>
        </div>
        <button
          type="button"
          onClick={() => void change()}
          disabled={busy || blockText !== null}
          className="btn-secondary focus-ring disabled:opacity-50"
          data-testid="settlement-toggle"
        >
          {enabled ? 'Switch to manual' : 'Turn on autopay'}
        </button>
      </div>
      <p className="text-xs text-muted">
        {enabled ? 'Posts by itself on each due date.' : 'Waits for you to record each payment.'}
      </p>
      {blockText && <p className="text-xs text-warn" data-testid="settlement-block">{blockText}</p>}
      {error && <p className="text-sm text-danger" role="alert" data-testid="settlement-error">{error}</p>}
    </div>
  )
}
