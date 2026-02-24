import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useCompleteOnboardingMutation } from '../../store/authApi'
import { SpotlightOverlay } from './SpotlightOverlay'

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

export function OnboardingFlow({ onComplete, onSkip }: OnboardingFlowProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null)
  const navigate = useNavigate()
  const [completeOnboarding] = useCompleteOnboardingMutation()

  // Disable scrolling and prevent body scroll when onboarding is active
  useEffect(() => {
    // Disable body scroll
    document.body.style.overflow = 'hidden'
    document.body.style.position = 'fixed'
    document.body.style.width = '100%'
    
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
      // Re-enable scrolling when component unmounts
      document.body.style.overflow = ''
      document.body.style.position = ''
      document.body.style.width = ''
      window.removeEventListener('keydown', handleKeyDown, { capture: true })
      window.removeEventListener('wheel', handleWheel, { capture: true })
      window.removeEventListener('touchmove', handleTouchMove, { capture: true })
    }
  }, [])

  const steps: OnboardingStep[] = [
    {
      id: 1,
      title: 'Welcome to Your Dashboard',
      description: 'This is your home overview where you can see all your financial information at a glance.',
      targetSelector: 'nav .hidden.sm\\:flex a[href="/"]',
      navigateTo: '/',
    },
    {
      id: 2,
      title: 'Manage Your Accounts',
      description: 'Track all your accounts - cash, savings, checking, and credit cards - in one place.',
      targetSelector: 'nav a[href="/accounts"]',
      navigateTo: '/accounts',
    },
    {
      id: 3,
      title: 'Record Transactions',
      description: 'Add and categorize your income and expenses to keep track of your spending.',
      targetSelector: 'nav a[href="/transactions"]',
      navigateTo: '/transactions',
    },
    {
      id: 4,
      title: 'Set Financial Goals',
      description: 'Create budgets, savings goals, and track your progress toward financial milestones.',
      targetSelector: 'nav a[href="/allocations"]',
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
  ]

  useEffect(() => {
    const step = steps[currentStep]
    if (!step) return

    // Navigate to the appropriate page if needed
    if (step.navigateTo) {
      navigate({ to: step.navigateTo as any })
    }

    // Wait for navigation and DOM update, then find target element
    const timer = setTimeout(() => {
      let element: HTMLElement | null = null

      if (step.targetSelector) {
        // For step 1, we need to find the Dashboard link specifically (not the logo)
        if (step.id === 1) {
          // Find all links with href="/" and get the one that contains "Dashboard" text
          const allLinks = document.querySelectorAll('nav a[href="/"]')
          element = Array.from(allLinks).find((link) => 
            link.textContent?.includes('Dashboard')
          ) as HTMLElement | null
        } else {
          element = document.querySelector(step.targetSelector) as HTMLElement
        }
      }

      setTargetElement(element)
      
      // Auto-scroll the element into view, accounting for the bottom onboarding panel
      if (element) {
        // Calculate the bottom panel height (approximately 200px for the onboarding panel)
        const bottomPanelHeight = 250
        const elementRect = element.getBoundingClientRect()
        const elementTop = elementRect.top + window.scrollY
        const elementHeight = elementRect.height
        const windowHeight = window.innerHeight
        const scrollPosition = elementTop - (windowHeight / 2) + (elementHeight / 2) + (bottomPanelHeight / 2)
        
        window.scrollTo({
          top: Math.max(0, scrollPosition),
          behavior: 'smooth',
        })
      }
    }, 500)

    return () => clearTimeout(timer)
  }, [currentStep, navigate])

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

  const currentStepData = steps[currentStep]

  if (!currentStepData) {
    return null
  }

  // Calculate bubble position based on target element
  const [bubblePosition, setBubblePosition] = useState<{ top: number; left: number; placement: 'top' | 'bottom' | 'left' | 'right' } | null>(null)

  useEffect(() => {
    if (targetElement) {
      const updateBubblePosition = () => {
        const rect = targetElement.getBoundingClientRect()
        const scrollY = window.scrollY
        const scrollX = window.scrollX
        
        // Determine best placement (prefer bottom, then top, then right, then left)
        const spaceBelow = window.innerHeight - rect.bottom
        const spaceAbove = rect.top
        const spaceRight = window.innerWidth - rect.right
        const spaceLeft = rect.left
        
        const bubbleWidth = 320
        const bubbleHeight = 200
        const offset = 20
        
        let top = 0
        let left = 0
        let placement: 'top' | 'bottom' | 'left' | 'right' = 'bottom'
        
        if (spaceBelow >= bubbleHeight + offset) {
          // Place below
          top = rect.bottom + scrollY + offset
          left = rect.left + scrollX + (rect.width / 2) - (bubbleWidth / 2)
          placement = 'bottom'
        } else if (spaceAbove >= bubbleHeight + offset) {
          // Place above
          top = rect.top + scrollY - bubbleHeight - offset
          left = rect.left + scrollX + (rect.width / 2) - (bubbleWidth / 2)
          placement = 'top'
        } else if (spaceRight >= bubbleWidth + offset) {
          // Place to the right
          top = rect.top + scrollY + (rect.height / 2) - (bubbleHeight / 2)
          left = rect.right + scrollX + offset
          placement = 'right'
        } else {
          // Place to the left
          top = rect.top + scrollY + (rect.height / 2) - (bubbleHeight / 2)
          left = rect.left + scrollX - bubbleWidth - offset
          placement = 'left'
        }
        
        // Keep bubble within viewport bounds
        left = Math.max(20, Math.min(left, window.innerWidth - bubbleWidth - 20))
        top = Math.max(20, Math.min(top, document.documentElement.scrollHeight - bubbleHeight - 20))
        
        setBubblePosition({ top, left, placement })
      }
      
      updateBubblePosition()
      window.addEventListener('resize', updateBubblePosition)
      window.addEventListener('scroll', updateBubblePosition, true)
      
      return () => {
        window.removeEventListener('resize', updateBubblePosition)
        window.removeEventListener('scroll', updateBubblePosition, true)
      }
    } else {
      setBubblePosition(null)
    }
  }, [targetElement])

  return (
    <SpotlightOverlay
      targetSelector={currentStepData.targetSelector}
      targetElement={targetElement}
      padding={12}
      borderRadius={8}
    >
      {bubblePosition && (
        <div 
          className="absolute z-[10000] bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-800 shadow-2xl pointer-events-auto w-80 transition-all duration-300"
          style={{
            top: `${bubblePosition.top}px`,
            left: `${bubblePosition.left}px`,
          }}
          data-onboarding-controls
        >
          <div className="p-4">
            {/* Progress indicator */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-600 dark:text-slate-400">
                  Step {currentStep + 1} of {TOTAL_STEPS}
                </span>
                <button
                  onClick={handleSkip}
                  className="text-xs text-gray-500 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-300 transition-colors"
                >
                  Skip
                </button>
              </div>
              <div className="w-full bg-gray-200 dark:bg-slate-700 rounded-full h-1.5">
                <div
                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${((currentStep + 1) / TOTAL_STEPS) * 100}%` }}
                ></div>
              </div>
            </div>

            {/* Step content */}
            <div className="mb-4">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1.5">
                {currentStepData.title}
              </h3>
              <p className="text-sm text-gray-600 dark:text-slate-400">{currentStepData.description}</p>
            </div>

            {/* Navigation buttons */}
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={handlePrevious}
                disabled={currentStep === 0}
                className="px-3 py-1.5 text-sm text-gray-700 dark:text-slate-300 bg-gray-100 dark:bg-slate-800 rounded-lg hover:bg-gray-200 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                {currentStep === TOTAL_STEPS - 1 ? 'Get Started' : 'Next'}
              </button>
            </div>
          </div>
          
          {/* Arrow pointing to the highlighted element */}
          <div
            className={`absolute w-0 h-0 border-8 ${
              bubblePosition.placement === 'bottom'
                ? 'border-b-white dark:border-b-slate-900 border-t-transparent border-l-transparent border-r-transparent -top-4 left-1/2 -translate-x-1/2'
                : bubblePosition.placement === 'top'
                ? 'border-t-white dark:border-t-slate-900 border-b-transparent border-l-transparent border-r-transparent -bottom-4 left-1/2 -translate-x-1/2'
                : bubblePosition.placement === 'right'
                ? 'border-r-white dark:border-r-slate-900 border-l-transparent border-t-transparent border-b-transparent -left-4 top-1/2 -translate-y-1/2'
                : 'border-l-white dark:border-l-slate-900 border-r-transparent border-t-transparent border-b-transparent -right-4 top-1/2 -translate-y-1/2'
            }`}
          />
        </div>
      )}
    </SpotlightOverlay>
  )
}
