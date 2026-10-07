export type BubblePlacement = 'top' | 'bottom' | 'left' | 'right' | 'center'

export interface BubbleLayout {
  top: number
  left: number
  placement: BubblePlacement
  /** Arrow position along the bubble edge that faces the target, in px. */
  arrowOffset: number
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

const GAP = 16 // between the highlight and the bubble
export const BUBBLE_VIEWPORT_MARGIN = 16
const MARGIN = BUBBLE_VIEWPORT_MARGIN // between the bubble and the viewport edge
const ARROW_INSET = 16 // keep the arrow off the bubble's corners

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Place the step bubble next to the highlighted box, in viewport coordinates.
 * Prefers below, then above, then right, then left; whatever side wins, the
 * bubble is clamped so it never leaves the viewport. With no target (or no
 * side with room) it is centred and drawn without an arrow.
 */
export function placeBubble(
  target: Box | null,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
): BubbleLayout {
  const maxLeft = viewport.width - bubble.width - MARGIN
  const maxTop = viewport.height - bubble.height - MARGIN

  if (!target) {
    return {
      top: clamp((viewport.height - bubble.height) / 2, MARGIN, maxTop),
      left: clamp((viewport.width - bubble.width) / 2, MARGIN, maxLeft),
      placement: 'center',
      arrowOffset: 0,
    }
  }

  const bottom = target.top + target.height
  const right = target.left + target.width
  const centreX = target.left + target.width / 2
  const centreY = target.top + target.height / 2

  let placement: BubblePlacement
  let top: number
  let left: number

  if (viewport.height - bottom >= bubble.height + GAP + MARGIN) {
    placement = 'bottom'
    top = bottom + GAP
    left = centreX - bubble.width / 2
  } else if (target.top >= bubble.height + GAP + MARGIN) {
    placement = 'top'
    top = target.top - GAP - bubble.height
    left = centreX - bubble.width / 2
  } else if (viewport.width - right >= bubble.width + GAP + MARGIN) {
    placement = 'right'
    top = centreY - bubble.height / 2
    left = right + GAP
  } else if (target.left >= bubble.width + GAP + MARGIN) {
    placement = 'left'
    top = centreY - bubble.height / 2
    left = target.left - GAP - bubble.width
  } else {
    // The target fills the screen (a tall card on a phone): overlap its lower edge.
    placement = 'center'
    top = maxTop
    left = (viewport.width - bubble.width) / 2
  }

  top = clamp(top, MARGIN, maxTop)
  left = clamp(left, MARGIN, maxLeft)

  const arrowOffset =
    placement === 'top' || placement === 'bottom'
      ? clamp(centreX - left, ARROW_INSET, bubble.width - ARROW_INSET)
      : clamp(centreY - top, ARROW_INSET, bubble.height - ARROW_INSET)

  return { top, left, placement, arrowOffset }
}
