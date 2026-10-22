import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { initialOverlayTiming, overlayStep } from '@tally-trace/shared'
import type { BusyLevel, OverlayPhase, OverlayTiming } from '@tally-trace/shared'
import { busySignal, isProgrammaticClickAllowed } from '../store/busy'
import { Spinner } from './Loading'

// The one app-wide screen loader (STU-335, R1 and R5). While any request is in flight
// (store/busy.ts) input is blocked from the first instant; after SHOW_DELAY_MS the
// screen dims and shows a spinner. Blocking starts synchronously inside the dispatch
// that made the level busy: focus is blurred, the app shell and every other body child
// except #root are made inert, and a window capture guard swallows input.

/** Every input event the capture guard sees while blocked. */
const GUARDED_EVENTS = [
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
  'touchstart', 'touchend', 'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'change',
  'paste', 'cut', 'drop', 'dragstart', 'compositionstart', 'compositionupdate', 'compositionend', 'submit',
] as const

/** The composition commit the overlay's own blur causes; swallowing it would split DOM and state. */
const OWN_BLUR_EVENTS = new Set(['compositionend', 'beforeinput', 'input', 'change'])

/** Body children that are never made inert. */
const NEVER_INERT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK'])

const HISTORY_SIZE = 10

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const STUCK_TEXT = 'This is taking longer than usual.'

/** F1-F12 or any Ctrl, Cmd or Alt chord: the browser still acts, the app never sees it. */
function isBrowserShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey || /^F([1-9]|1[0-2])$/.test(event.key)
}

interface View {
  phase: OverlayPhase
  stuck: boolean
  label: string
}

const hiddenView: View = { phase: 'hidden', stuck: false, label: '' }

interface ControllerRefs {
  layer: { readonly current: HTMLDivElement | null }
  reload: { readonly current: HTMLButtonElement | null }
}

/** One recorded change to the page, reverted by `undoRecorded()`. */
interface RecordedChange {
  undo: () => void
}

/**
 * The imperative part: subscribes to the busy level, runs the timing rules, blocks and
 * unblocks the page, and restores focus. Returns its teardown.
 */
function startController(host: HTMLElement, refs: ControllerRefs, setView: (view: View) => void): () => void {
  let level: BusyLevel = busySignal.get()
  let timing: OverlayTiming = initialOverlayTiming
  let phase: OverlayPhase = 'hidden'
  let blocked = false
  let episodeSaving = false
  let selfBlur: Element | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let frame: number | null = null
  let evaluating = false
  let again = false
  let destroyed = false
  const recorded: RecordedChange[] = []
  const history: HTMLElement[] = []
  let bodyObserver: MutationObserver | null = null

  const remember = (el: HTMLElement) => {
    const at = history.indexOf(el)
    if (at !== -1) history.splice(at, 1)
    history.push(el)
    if (history.length > HISTORY_SIZE) history.shift()
  }

  const setInert = (el: Element) => {
    if (el.hasAttribute('inert')) return
    el.setAttribute('inert', '')
    recorded.push({ undo: () => el.removeAttribute('inert') })
  }

  const undoRecorded = () => {
    for (const change of recorded.splice(0).reverse()) change.undo()
  }

  const inertsBodyChild = (node: Node): node is Element =>
    node instanceof Element && node !== host && node.id !== 'root' && !NEVER_INERT.has(node.tagName)

  const startBlock = () => {
    // 1. Blur: ends an IME composition, closes a native select list and the autofill
    //    list, and stops a number input taking wheel steps.
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !host.contains(active)) {
      remember(active)
      selfBlur = active
      active.blur()
      setTimeout(() => {
        if (selfBlur === active) selfBlur = null
      }, 0)
    }
    // 2. Inert: the app shell, and every other body child except #root (the dialogs own
    //    it) and the host. Nodes added while blocked (a dialog portal) are inerted too.
    const shell = document.querySelector('[data-app-shell]')
    if (shell) setInert(shell)
    for (const child of Array.from(document.body.children)) if (inertsBodyChild(child)) setInert(child)
    bodyObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) if (inertsBodyChild(node)) setInert(node)
      }
    })
    bodyObserver.observe(document.body, { childList: true })
    // 3. The capture guard reads this.
    blocked = true
  }

  const isCandidate = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement &&
    el.isConnected &&
    !el.matches(':disabled') &&
    el.closest('[inert]') === null &&
    el.getClientRects().length > 0

  const restoreFocus = () => {
    const active = document.activeElement
    if (active !== null && active !== document.body && !host.contains(active)) return
    const focus = (el: HTMLElement) => el.focus({ preventScroll: true })
    const newestFirst = [...history].reverse()
    const modals = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(
      (m) => !host.contains(m) && m.closest('[inert]') === null,
    )
    const modal = modals[modals.length - 1]
    if (modal) {
      const inside = newestFirst.find((el) => modal.contains(el) && isCandidate(el))
      if (inside) return focus(inside)
      const first = Array.from(modal.querySelectorAll(FOCUSABLE)).find(isCandidate)
      if (first) focus(first)
      return
    }
    const last = newestFirst.find(isCandidate)
    if (last) return focus(last)
    const main = document.getElementById('main-content')
    if (isCandidate(main)) focus(main)
  }

  const endBlock = () => {
    blocked = false
    bodyObserver?.disconnect()
    bodyObserver = null
    undoRecorded()
    restoreFocus()
  }

  const schedule = (wakeAt: number | null) => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (wakeAt === null) return
    timer = setTimeout(() => {
      timer = null
      evaluate(false)
    }, Math.max(0, wakeAt - performance.now()))
  }

  const frames = () => {
    const wanted = !level.busy && phase !== 'hidden'
    if (wanted && frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null
        evaluate(true)
      })
    } else if (!wanted && frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }

  const step = (frameTick: boolean) => {
    const before = phase
    const next = overlayStep(timing, level.busy, performance.now(), frameTick)
    timing = next.timing
    if (level.saving) episodeSaving = true
    if (before === 'hidden' && next.phase !== 'hidden') startBlock()
    phase = next.phase
    if (before !== 'hidden' && next.phase === 'hidden') {
      endBlock()
      episodeSaving = false
    }
    schedule(next.wakeAt)
    frames()
    const label = phase === 'visible' ? (episodeSaving ? 'Saving…' : 'Loading…') : ''
    setView({ phase, stuck: next.stuck, label })
  }

  // Re-entrant safe: a blur handler can dispatch, and that dispatch publishes again.
  const evaluate = (frameTick: boolean) => {
    if (destroyed) return
    if (evaluating) {
      again = true
      return
    }
    evaluating = true
    try {
      let tick = frameTick
      do {
        again = false
        step(tick)
        tick = false
      } while (again)
    } finally {
      evaluating = false
    }
  }

  const onGuard = (event: Event) => {
    if (!blocked) return
    const target = event.target
    if (event.type === 'click' && isProgrammaticClickAllowed(target)) return
    const isKey = event instanceof KeyboardEvent
    if (target instanceof Node && host.contains(target)) {
      // Pointer and click events reach the layer and Reload; keys never reach the app.
      if (!isKey) return
      event.stopImmediatePropagation()
      if (isBrowserShortcut(event) || event.key === 'Tab') return
      if ((event.key === 'Enter' || event.key === ' ') && target === refs.reload.current) return
      event.preventDefault()
      return
    }
    if (target !== null && target === selfBlur && OWN_BLUR_EVENTS.has(event.type)) return
    if (isKey && isBrowserShortcut(event)) {
      event.stopImmediatePropagation()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (target instanceof HTMLElement && !host.contains(target)) remember(target)
  }

  for (const type of GUARDED_EVENTS) window.addEventListener(type, onGuard, { capture: true })
  document.addEventListener('focusin', onFocusIn, { capture: true })
  const unsubscribe = busySignal.subscribe((next) => {
    level = next
    evaluate(false)
  })
  // A level that was already busy at mount blocks at once.
  evaluate(false)

  return () => {
    destroyed = true
    unsubscribe()
    for (const type of GUARDED_EVENTS) window.removeEventListener(type, onGuard, { capture: true })
    document.removeEventListener('focusin', onFocusIn, { capture: true })
    bodyObserver?.disconnect()
    bodyObserver = null
    undoRecorded()
    blocked = false
    if (timer !== null) clearTimeout(timer)
    if (frame !== null) cancelAnimationFrame(frame)
  }
}

/**
 * Rendered once, in Layout's signed-in branch. Portals into a host outside #root, above
 * every other layer; the layer is always rendered and carries `data-phase`.
 */
export function BusyOverlay() {
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.setAttribute('data-busy-host', '')
    el.className = 'fixed inset-0 z-[10050] pointer-events-none'
    return el
  })
  const layerRef = useRef<HTMLDivElement>(null)
  const reloadRef = useRef<HTMLButtonElement>(null)
  const [view, setView] = useState<View>(hiddenView)

  useLayoutEffect(() => {
    document.body.appendChild(host)
    const stop = startController(host, { layer: layerRef, reload: reloadRef }, setView)
    return () => {
      stop()
      host.remove()
    }
  }, [host])

  // At `visible` the layer takes focus, unless focus is already inside the host.
  useLayoutEffect(() => {
    if (view.phase !== 'visible') return
    const layer = layerRef.current
    if (!layer || host.contains(document.activeElement)) return
    layer.focus({ preventScroll: true })
  }, [view.phase, host])

  const visible = view.phase === 'visible'
  const blocking = view.phase !== 'hidden'

  return createPortal(
    <>
      <div
        ref={layerRef}
        data-testid="busy-overlay"
        data-phase={view.phase}
        data-stuck={view.stuck ? 'true' : 'false'}
        className={[
          'absolute inset-0 flex items-center justify-center px-4 outline-none',
          'transition-opacity motion-reduce:transition-none motion-reduce:duration-0',
          blocking ? 'pointer-events-auto' : 'pointer-events-none',
          visible ? 'bg-black/40 opacity-100' : 'opacity-0',
        ].join(' ')}
        aria-hidden={visible ? undefined : 'true'}
        role={visible ? 'dialog' : undefined}
        aria-modal={visible ? 'true' : undefined}
        aria-label={visible ? 'Please wait' : undefined}
        tabIndex={visible ? -1 : undefined}
      >
        {visible && (
          <div className="card flex flex-col items-center gap-3 p-6 text-center">
            <Spinner size="lg" className="motion-reduce:animate-none" />
            <p className="text-sm text-body" aria-hidden="true">
              {view.label}
            </p>
            {view.stuck && (
              <>
                <p className="text-sm text-body">{STUCK_TEXT}</p>
                <button
                  ref={reloadRef}
                  type="button"
                  data-testid="busy-reload"
                  className="btn-secondary focus-ring"
                  onClick={() => window.location.reload()}
                >
                  Reload page
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div role="status" aria-live="polite" className="sr-only" data-testid="busy-status">
        {view.label}
      </div>
    </>,
    host,
  )
}
