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
      {/* Gray background overlay */}
      <div
        className="absolute inset-0 bg-gray-500/75 dark:bg-gray-900/75 transition-opacity duration-300"
        style={{ opacity: isVisible ? 1 : 0 }}
      />

      {/* Highlight border - no dimming, just the border to draw attention */}
      <div
        className="absolute border-4 border-blue-500 dark:border-blue-400 shadow-2xl shadow-blue-500/70 transition-all duration-300 ring-4 ring-blue-500/30 dark:ring-blue-400/30"
        style={{
          top: highlightTop,
          left: highlightLeft,
          width: highlightWidth,
          height: highlightHeight,
          borderRadius: borderRadius,
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
