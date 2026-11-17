import { tokenColor } from '../../utils/palette'

export interface SpotlightRect {
  top: number
  left: number
  width: number
  height: number
}

interface SpotlightOverlayProps {
  /** Target box in viewport coordinates; null while the target is not on screen yet. */
  rect: SpotlightRect | null
  children?: React.ReactNode
  padding?: number
  borderRadius?: number
}

// The scrim token at 0.55: --ink flips light in dark mode, and the scrim is the same dark in both.
const SCRIM = tokenColor('scrim', 0.55)

export function SpotlightOverlay({
  rect,
  children,
  padding = 8,
  borderRadius = 8,
}: SpotlightOverlayProps) {
  return (
    <div data-onboarding-overlay className="fixed inset-0 z-[9999] pointer-events-none overflow-hidden">
      {rect ? (
        // Highlight: its huge spread shadow is the scrim, so the target inside
        // the cut-out stays undimmed while the rest of the app shows through.
        // No transition here — the position is re-measured every frame.
        <div
          data-onboarding-highlight
          className="absolute border-2 border-ink"
          style={{
            top: rect.top - padding,
            left: rect.left - padding,
            width: rect.width + padding * 2,
            height: rect.height + padding * 2,
            borderRadius: borderRadius,
            boxShadow: `0 0 0 9999px ${SCRIM}`,
          }}
        />
      ) : (
        // Target not resolved yet: dim everything, keep the tour controls up
        <div className="absolute inset-0" style={{ backgroundColor: SCRIM }} />
      )}

      {/* Content overlay */}
      {children && (
        <div className="absolute inset-0 pointer-events-auto" style={{ zIndex: 1 }}>
          {children}
        </div>
      )}
    </div>
  )
}
