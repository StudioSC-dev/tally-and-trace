import { useState, useEffect, useLayoutEffect, useMemo, useRef, useId } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useCompleteOnboardingMutation } from '../../store/authApi'
import { SpotlightOverlay, type SpotlightRect } from './SpotlightOverlay'
import { resolveOnboardingTarget } from './resolveTarget'
import { placeBubble, BUBBLE_VIEWPORT_MARGIN } from './placeBubble'

interface OnboardingStep {
  id: number
  title: string
  description: string
  targetSelector?: string
  targetElement?: HTMLElement | null
  navigateTo?: string
  content?: React.ReactNode
}

interface OnboardingFlowProps {
  onComplete?: () => void
  onSkip?: () => void
}

const TOTAL_STEPS = 8
const HIGHLIGHT_PADDING = 12
// Used until the bubble has rendered once and can be measured (w-80 ≈ 320px).
const BUBBLE_FALLBACK_SIZE = { width: 320, height: 200 }
// Clearance for the fixed top bar and the mobile bottom tab bar (both h-16).
const CHROME_CLEARANCE = 72
// Minimum gap between corrective re-scrolls, so a smooth scroll in progress is
// not restarted every frame.
const RESCROLL_INTERVAL_MS = 500

function isInFixedLayer(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return true
  }
  return false
}

// Nearest ancestor that clips the element, e.g. the desktop nav link strip,
// which scrolls sideways when the links do not fit (narrow desktop widths, or
// with the entity switcher shown).
function clippingAncestor(element: HTMLElement) {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return node
  }
  return null
}

function isClippedBy(rect: DOMRect, container: HTMLElement) {
  const box = container.getBoundingClientRect()
  return rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom
}

// Scroll only the clipping container, by adjusting its scroll offsets directly.
// scrollIntoView would also be free to scroll the window, and for elements in
// a fixed layer browsers disagree on whether it does.
function revealWithinClippingAncestor(element: HTMLElement) {
  const container = clippingAncestor(element)
  if (!container) return
  const rect = element.getBoundingClientRect()
  const box = container.getBoundingClientRect()
  if (rect.left < box.left) container.scrollLeft -= Math.ceil(box.left - rect.left)
  else if (rect.right > box.right) container.scrollLeft += Math.ceil(rect.right - box.right)
  if (rect.top < box.top) container.scrollTop -= Math.ceil(box.top - rect.top)
  else if (rect.bottom > box.bottom) container.scrollTop += Math.ceil(rect.bottom - box.bottom)
}

// Bring a below-the-fold target to the middle of the screen. Nav items live in
// fixed bars and are always on screen, so the page is left alone and only the
// bar's own clipped strip is scrolled, if needed.
function scrollTargetIntoView(element: HTMLElement) {
  if (isInFixedLayer(element)) {
    revealWithinClippingAncestor(element)
    return
  }
  const rect = element.getBoundingClientRect()
  if (rect.top >= CHROME_CLEARANCE && rect.bottom <= window.innerHeight - CHROME_CLEARANCE) return
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
}

interface Size {
  width: number
  height: number
}

interface Geometry {
  element: HTMLElement | null
  target: SpotlightRect | null
  bubble: Size
  viewport: Size
}

// Sub-pixel jitter is not worth a re-render
const GEOMETRY_EPSILON = 0.5

function numbersClose(a: number, b: number) {
  return Math.abs(a - b) <= GEOMETRY_EPSILON
}

function sameGeometry(a: Geometry | null, b: Geometry) {
  if (!a || a.element !== b.element) return false
  if (!numbersClose(a.bubble.width, b.bubble.width) || !numbersClose(a.bubble.height, b.bubble.height)) return false
  if (!numbersClose(a.viewport.width, b.viewport.width) || !numbersClose(a.viewport.height, b.viewport.height)) return false
  if (!a.target || !b.target) return a.target === b.target
  return (
    numbersClose(a.target.top, b.target.top) &&
    numbersClose(a.target.left, b.target.left) &&
    numbersClose(a.target.width, b.target.width) &&
    numbersClose(a.target.height, b.target.height)
  )
}

export function OnboardingFlow({ onComplete, onSkip }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(0)
  // Tagged with its step, so a target found for one step is never shown for another
  const [resolved, setResolved] = useState<{ step: number; element: HTMLElement } | null>(null)
  const targetElement = resolved?.step === currentStep ? resolved.element : null
  const navigate = useNavigate()
  const [completeOnboarding] = useCompleteOnboardingMutation()

  // Stop the user scrolling while the tour is active. overflow:hidden on the
  // root still allows programmatic scrolling, which the tour needs to bring
  // below-the-fold cards into view (body position:fixed did not).
  useEffect(() => {
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'

    // The bubble's body text is the one region allowed to scroll, so long
    // copy stays readable on short screens.
    const inBubbleScroll = (e: Event) =>
      e.target instanceof Element && e.target.closest('[data-onboarding-scroll]') !== null

    // Prevent keyboard navigation
    const handleKeyDown = (e: KeyboardEvent) => {
      // Scrolling keys work inside the focused body text region
      if (inBubbleScroll(e)) return
      // Allow only Tab, Enter, Escape for navigation
      if (!['Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    
    // Prevent scroll events
    const handleWheel = (e: WheelEvent) => {
      if (inBubbleScroll(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    
    // Prevent touch scroll
    const handleTouchMove = (e: TouchEvent) => {
      if (inBubbleScroll(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    window.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true })
    
    return () => {
      root.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('wheel', handleWheel, { capture: true })
      window.removeEventListener('touchmove', handleTouchMove, { capture: true })
    }
  }, [])

  const steps: OnboardingStep[] = useMemo(() => [
    {
      id: 1,
      title: 'Welcome to Your Dashboard',
      description: 'This is your home overview where you can see all your financial information at a glance.',
      targetSelector: '[data-onboarding="nav-home"]',
      navigateTo: '/',
    },
    {
      id: 2,
      title: 'Manage Your Accounts',
      description: 'Track all your accounts - cash, savings, checking, and credit cards - in one place.',
      targetSelector: '[data-onboarding="nav-accounts"]',
      navigateTo: '/accounts',
    },
    {
      id: 3,
      title: 'Record Transactions',
      description: 'Add and categorize your income and expenses to keep track of your spending.',
      targetSelector: '[data-onboarding="nav-transactions"]',
      navigateTo: '/transactions',
    },
    {
      id: 4,
      title: 'Set Financial Goals',
      description: 'Create budgets, savings goals, and track your progress toward financial milestones.',
      targetSelector: '[data-onboarding="nav-allocations"]',
      navigateTo: '/allocations',
    },
    {
      id: 5,
      title: 'Financial Snapshot',
      description: 'View your total balance, income, expenses, and net flow for the selected period.',
      targetSelector: '[data-onboarding="financial-snapshot"]',
      navigateTo: '/',
    },
    {
      id: 6,
      title: 'Budget Envelope Status',
      description: 'Monitor your spending against budget limits to stay on track with your financial goals.',
      targetSelector: '[data-onboarding="budget-envelopes"]',
      navigateTo: '/',
    },
    {
      id: 7,
      title: 'Upcoming Planned Expenses',
      description: 'See your scheduled payments and expenses to plan ahead and avoid surprises.',
      targetSelector: '[data-onboarding="upcoming-expenses"]',
      navigateTo: '/',
    },
    {
      id: 8,
      title: 'Top Expenditure Categories',
      description: 'Understand where your money goes with a visual breakdown of your spending by category.',
      targetSelector: '[data-onboarding="top-categories"]',
      navigateTo: '/',
    },
  ], [])

  useEffect(() => {
    const step = steps[currentStep]
    if (step?.navigateTo) {
      navigate({ to: step.navigateTo as '/' })
    }
  }, [currentStep, navigate, steps])

  // Find the step's target, waiting for it if the page has not rendered it yet
  // (route change, dashboard still loading). Re-runs when the target is lost.
  useEffect(() => {
    if (targetElement) return
    const step = steps[currentStep]
    if (!step) return

    let done = false
    const attempt = () => {
      if (done) return
      const element = resolveOnboardingTarget(step.targetSelector)
      if (!element) return
      stop()
      setResolved({ step: currentStep, element })
      scrollTargetIntoView(element)
    }
    const observer = new MutationObserver((records) => {
      // The tour's own re-renders (bubble and highlight moving) cannot reveal a target
      const external = records.some(
        (record) => !(record.target instanceof Element && record.target.closest('[data-onboarding-overlay]')),
      )
      if (external) attempt()
    })
    const stop = () => {
      done = true
      observer.disconnect()
      window.removeEventListener('resize', attempt)
    }

    // Attributes as well as childList: a target can be revealed by a class or
    // style change (a breakpoint-hidden container, a collapsed section) without
    // any node being added.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    })
    window.addEventListener('resize', attempt)
    attempt()

    return stop
  }, [currentStep, targetElement, steps])

  const handleNext = () => {
    if (currentStep < TOTAL_STEPS - 1) {
      setCurrentStep(currentStep + 1)
    } else {
      handleComplete()
    }
  }

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1)
    }
  }

  const handleSkip = async () => {
    try {
      await completeOnboarding().unwrap()
      onSkip?.()
    } catch (error) {
      console.error('Failed to skip onboarding:', error)
      onSkip?.()
    }
  }

  const handleComplete = async () => {
    try {
      await completeOnboarding().unwrap()
      onComplete?.()
    } catch (error) {
      console.error('Failed to complete onboarding:', error)
      onComplete?.()
    }
  }

  // Track the target, the bubble and the viewport every frame while a step is
  // active, so the highlight follows layout shifts (cards loading, smooth
  // scroll, resize). State only changes when something actually moved.
  const bubbleRef = useRef<HTMLDivElement>(null)
  // Whether the body text overflows; only then is it a (keyboard) scroll region
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastBodyScrollable = useRef(false)
  const [bodyScrollable, setBodyScrollable] = useState(false)
  const titleId = useId()
  const lastGeometry = useRef<Geometry | null>(null)
  const [geometry, setGeometry] = useState<Geometry | null>(null)

  useLayoutEffect(() => {
    let frame = 0
    let lastRescroll = 0
    const targetIsFixed = targetElement ? isInFixedLayer(targetElement) : true
    const clipper = targetElement && targetIsFixed ? clippingAncestor(targetElement) : null
    const measure = () => {
      let target: SpotlightRect | null = null
      if (targetElement) {
        const rect = targetElement.getBoundingClientRect()
        if (!targetElement.isConnected || rect.width === 0 || rect.height === 0) {
          // The target went away (re-render, route change): look for it again
          setResolved(null)
        } else {
          target = { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          // Content above the target grew after it was scrolled to (a card
          // finishing its own load) and pushed it off screen, or a nav link sits
          // under its strip's clip edge. The user cannot scroll during the
          // tour, so bring it back.
          const hidden = targetIsFixed
            ? clipper !== null && isClippedBy(rect, clipper)
            : rect.bottom <= CHROME_CLEARANCE || rect.top >= window.innerHeight - CHROME_CLEARANCE
          const now = performance.now()
          if (hidden && now - lastRescroll >= RESCROLL_INTERVAL_MS) {
            lastRescroll = now
            scrollTargetIntoView(targetElement)
          }
        }
      }
      const bubble = bubbleRef.current
      const next: Geometry = {
        element: target ? targetElement : null,
        target,
        bubble: bubble ? { width: bubble.offsetWidth, height: bubble.offsetHeight } : BUBBLE_FALLBACK_SIZE,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
      if (!sameGeometry(lastGeometry.current, next)) {
        lastGeometry.current = next
        setGeometry(next)
      }
      const body = bodyRef.current
      const scrollable = !!body && body.scrollHeight > body.clientHeight + 1
      if (scrollable !== lastBodyScrollable.current) {
        lastBodyScrollable.current = scrollable
        setBodyScrollable(scrollable)
      }
      frame = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(frame)
  }, [targetElement])

  const currentStepData = steps[currentStep]

  if (!currentStepData) {
    return null
  }

  const targetRect =
    targetElement && geometry?.element === targetElement ? geometry.target : null
  const bubbleLayout = placeBubble(
    targetRect && {
      top: targetRect.top - HIGHLIGHT_PADDING,
      left: targetRect.left - HIGHLIGHT_PADDING,
      width: targetRect.width + HIGHLIGHT_PADDING * 2,
      height: targetRect.height + HIGHLIGHT_PADDING * 2,
    },
    geometry?.bubble ?? BUBBLE_FALLBACK_SIZE,
    geometry?.viewport ?? { width: window.innerWidth, height: window.innerHeight },
  )

  return (
    <SpotlightOverlay rect={targetRect} padding={HIGHLIGHT_PADDING} borderRadius={8}>
      {/* Always rendered, even before the target is found, so the tour can
          never strand the user behind the overlay without controls. */}
      <div
        ref={bubbleRef}
        className="absolute z-[10000] flex flex-col bg-surface border border-line pointer-events-auto w-80 max-w-[calc(100vw-2rem)]"
        style={{
          top: `${bubbleLayout.top}px`,
          left: `${bubbleLayout.left}px`,
          // Never taller than the viewport, so the controls cannot be clipped;
          // the measured (capped) height is what placeBubble positions.
          maxHeight: `${(geometry?.viewport.height ?? window.innerHeight) - BUBBLE_VIEWPORT_MARGIN * 2}px`,
        }}
        data-onboarding-controls
      >
        <div className="flex min-h-0 flex-col p-4">
          {/* Progress indicator */}
          <div className="mb-3 shrink-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-body">
                Step {currentStep + 1} of {TOTAL_STEPS}
              </span>
              <button
                onClick={handleSkip}
                className="text-xs text-muted hover:text-body transition-colors"
              >
                Skip
              </button>
            </div>
            <div className="w-full bg-sunken rounded-full h-1.5">
              <div
                className="bg-ink h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${((currentStep + 1) / TOTAL_STEPS) * 100}%` }}
              ></div>
            </div>
          </div>

          {/* Step content — the only part that scrolls when space is short */}
          <div
            ref={bodyRef}
            className="mb-4 min-h-0 overflow-y-auto overscroll-contain focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            data-onboarding-scroll
            {...(bodyScrollable
              ? { tabIndex: 0, role: 'region', 'aria-labelledby': titleId }
              : {})}
          >
            <h3 id={titleId} className="text-base font-semibold text-ink mb-1.5">
              {currentStepData.title}
            </h3>
            <p className="text-sm text-body">{currentStepData.description}</p>
          </div>

          {/* Navigation buttons */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <button
              onClick={handlePrevious}
              disabled={currentStep === 0}
              className="px-3 py-1.5 text-sm text-body bg-sunken hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <button
              onClick={handleNext}
              className="ml-auto px-4 py-1.5 text-sm bg-ink text-paper hover:bg-ink transition-colors font-medium"
            >
              {currentStep === TOTAL_STEPS - 1 ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
        
        {/* Arrow pointing to the highlighted element */}
        {bubbleLayout.placement !== 'center' && (
          <div
            className={`absolute w-0 h-0 border-8 ${ bubbleLayout.placement === 'bottom' ? 'border-b-surface border-t-transparent border-l-transparent border-r-transparent -top-4 -translate-x-1/2' : bubbleLayout.placement === 'top' ? 'border-t-surface border-b-transparent border-l-transparent border-r-transparent -bottom-4 -translate-x-1/2' : bubbleLayout.placement === 'right' ? 'border-r-surface border-l-transparent border-t-transparent border-b-transparent -left-4 -translate-y-1/2' : 'border-l-surface border-r-transparent border-t-transparent border-b-transparent -right-4 -translate-y-1/2' }`}
            style={
              bubbleLayout.placement === 'top' || bubbleLayout.placement === 'bottom'
                ? { left: bubbleLayout.arrowOffset }
                : { top: bubbleLayout.arrowOffset }
            }
          />
        )}
      </div>
    </SpotlightOverlay>
  )
}
