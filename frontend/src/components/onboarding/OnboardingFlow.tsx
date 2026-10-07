import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useCompleteOnboardingMutation } from '../../store/authApi'
import { SpotlightOverlay } from './SpotlightOverlay'
import { resolveOnboardingTarget } from './resolveTarget'
import { placeBubble, type BubbleLayout } from './placeBubble'

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

function isInFixedLayer(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return true
  }
  return false
}

// Bring a below-the-fold target to the middle of the screen. Nav items live in
// fixed bars and are always on screen, so they are left alone.
function scrollTargetIntoView(element: HTMLElement) {
  if (isInFixedLayer(element)) return
  const rect = element.getBoundingClientRect()
  if (rect.top >= CHROME_CLEARANCE && rect.bottom <= window.innerHeight - CHROME_CLEARANCE) return
  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
}

export function OnboardingFlow({ onComplete, onSkip }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null)
  const navigate = useNavigate()
  const [completeOnboarding] = useCompleteOnboardingMutation()

  // Stop the user scrolling while the tour is active. overflow:hidden on the
  // root still allows programmatic scrolling, which the tour needs to bring
  // below-the-fold cards into view (body position:fixed did not).
  useEffect(() => {
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'

    // Prevent keyboard navigation
    const handleKeyDown = (e: KeyboardEvent) => {
      // Allow only Tab, Enter, Escape for navigation
      if (!['Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    
    // Prevent scroll events
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    
    // Prevent touch scroll
    const handleTouchMove = (e: TouchEvent) => {
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
    if (!step) return

    // Navigate to the appropriate page if needed
    if (step.navigateTo) {
      navigate({ to: step.navigateTo as '/' })
    }

    // Wait for navigation and DOM update, then find target element
    const timer = setTimeout(() => {
      const element = resolveOnboardingTarget(step.targetSelector)

      setTargetElement(element)
      if (element) scrollTargetIntoView(element)
    }, 500)

    return () => clearTimeout(timer)
  }, [currentStep, navigate, steps])

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

  // Bubble position, in viewport coordinates (the overlay is position:fixed)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [bubbleLayout, setBubbleLayout] = useState<BubbleLayout | null>(null)

  useEffect(() => {
    if (!targetElement) {
      setBubbleLayout(null)
      return
    }

    const updateBubblePosition = () => {
      const rect = targetElement.getBoundingClientRect()
      const bubble = bubbleRef.current
      setBubbleLayout(
        placeBubble(
          {
            top: rect.top - HIGHLIGHT_PADDING,
            left: rect.left - HIGHLIGHT_PADDING,
            width: rect.width + HIGHLIGHT_PADDING * 2,
            height: rect.height + HIGHLIGHT_PADDING * 2,
          },
          bubble
            ? { width: bubble.offsetWidth, height: bubble.offsetHeight }
            : BUBBLE_FALLBACK_SIZE,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      )
    }

    updateBubblePosition()
    // Place again once the bubble has rendered and its real size is known
    const frame = requestAnimationFrame(updateBubblePosition)
    window.addEventListener('resize', updateBubblePosition)
    window.addEventListener('scroll', updateBubblePosition, true)

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', updateBubblePosition)
      window.removeEventListener('scroll', updateBubblePosition, true)
    }
  }, [targetElement])

  const currentStepData = steps[currentStep]

  if (!currentStepData) {
    return null
  }

  return (
    <SpotlightOverlay
      targetSelector={currentStepData.targetSelector}
      targetElement={targetElement}
      padding={HIGHLIGHT_PADDING}
      borderRadius={8}
    >
      {bubbleLayout && (
        <div
          ref={bubbleRef}
          className="absolute z-[10000] bg-surface border border-line pointer-events-auto w-80 max-w-[calc(100vw-2rem)] transition-all duration-300"
          style={{
            top: `${bubbleLayout.top}px`,
            left: `${bubbleLayout.left}px`,
          }}
          data-onboarding-controls
        >
          <div className="p-4">
            {/* Progress indicator */}
            <div className="mb-3">
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

            {/* Step content */}
            <div className="mb-4">
              <h3 className="text-base font-semibold text-ink mb-1.5">
                {currentStepData.title}
              </h3>
              <p className="text-sm text-body">{currentStepData.description}</p>
            </div>

            {/* Navigation buttons */}
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={handlePrevious}
                disabled={currentStep === 0}
                className="px-3 py-1.5 text-sm text-body bg-sunken hover:bg-sunken disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                className="px-4 py-1.5 text-sm bg-ink text-paper hover:bg-ink transition-colors font-medium"
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
      )}
    </SpotlightOverlay>
  )
}
