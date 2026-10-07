import { useEffect, useRef, useState } from 'react'

interface SpotlightOverlayProps {
  targetSelector?: string
  targetElement?: HTMLElement | null
  children?: React.ReactNode
  padding?: number
  borderRadius?: number
}

export function SpotlightOverlay({
  targetSelector,
  targetElement,
  children,
  padding = 8,
  borderRadius = 8,
}: SpotlightOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const updateHighlight = () => {
      let element: HTMLElement | null = null

      if (targetElement) {
        element = targetElement
      } else if (targetSelector) {
        element = document.querySelector(targetSelector) as HTMLElement
      }

      if (element) {
        const rect = element.getBoundingClientRect()
        setHighlightRect(rect)
        setIsVisible(true)
      } else {
        setIsVisible(false)
      }
    }

    updateHighlight()
    window.addEventListener('resize', updateHighlight)
    window.addEventListener('scroll', updateHighlight, true)

    return () => {
      window.removeEventListener('resize', updateHighlight)
      window.removeEventListener('scroll', updateHighlight, true)
    }
  }, [targetSelector, targetElement])

  if (!isVisible || !highlightRect) {
    return null
  }

  const { width, height, top, left } = highlightRect
  const highlightWidth = width + padding * 2
  const highlightHeight = height + padding * 2
  const highlightTop = top - padding + window.scrollY
  const highlightLeft = left - padding + window.scrollX

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] pointer-events-none overflow-hidden"
      style={{ top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {/* Highlight: its huge spread shadow is the scrim, so the target inside
          the cut-out stays undimmed while the rest of the app shows through.
          The scrim is a fixed translucent black rather than a token: --ink
          flips light in dark mode, and the paper tokens carry no alpha channel. */}
      <div
        data-onboarding-highlight
        className="absolute border-2 border-ink transition-all duration-300"
        style={{
          top: highlightTop,
          left: highlightLeft,
          width: highlightWidth,
          height: highlightHeight,
          borderRadius: borderRadius,
          boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)',
          pointerEvents: 'none',
        }}
      />

      {/* Content overlay */}
      {children && (
        <div className="absolute inset-0 pointer-events-auto" style={{ zIndex: 1 }}>
          {children}
        </div>
      )}
    </div>
  )
}
