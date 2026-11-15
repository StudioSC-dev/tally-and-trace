import { useEffect, useId, useRef, useState } from 'react'
import type { InputHTMLAttributes, KeyboardEvent } from 'react'
import { createLatestGate, descriptionKey, exactSuggestion } from '@tally-trace/shared'
import type { DescriptionSuggestion } from '@tally-trace/shared'
import { useLazyGetDescriptionSuggestionsQuery } from '../../store/api'

// How long typing pauses before the suggestions are asked for.
const SUGGEST_DELAY_MS = 150

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onFocus' | 'onKeyDown'> & {
  value: string
  onValueChange: (value: string) => void
  /** Add Transaction only: Edit never asks for suggestions and never autofills. */
  enabled: boolean
  /** A suggestion was picked, or the field was left on an exact match (STU-626). */
  onAutofill: (suggestion: DescriptionSuggestion) => void
  /** Changes when the form is reset (a new entry): drops the list and any answer in flight. */
  resetKey: number
}

/**
 * The Description input with the descriptions used before listed under it (STU-626). A plain
 * input and a list, no new dependency. Each request takes a ticket (`createLatestGate`): an
 * answer for an earlier value is dropped, and a failed request just shows no list, so manual
 * entry and saving carry on as without suggestions.
 */
export function DescriptionAutofillInput({ value, onValueChange, enabled, onAutofill, resetKey, ...inputProps }: Props) {
  const [fetchSuggestions] = useLazyGetDescriptionSuggestionsQuery()
  const gate = useRef(createLatestGate())
  const current = useRef(value)
  current.current = value
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The answer for one Description value: shown only while it is still the value.
  const [answer, setAnswer] = useState<{ key: string; items: DescriptionSuggestion[] }>({ key: '', items: [] })
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()

  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => {
    cancelTimer()
    gate.current.reset()
    setAnswer({ key: '', items: [] })
    setActive(-1)
  }, [resetKey])
  useEffect(() => () => cancelTimer(), [])

  /** Ask for `q`'s suggestions; `thenExact` autofills from an exact match once they arrive. */
  const ask = (q: string, thenExact = false) => {
    cancelTimer()
    const key = descriptionKey(q)
    if (!key) return
    const ticket = gate.current.next(q)
    fetchSuggestions(q)
      .unwrap()
      .then((result) => {
        if (!gate.current.accepts(ticket, current.current)) return
        setAnswer({ key, items: result.items })
        if (thenExact) {
          const exact = exactSuggestion(result.items, current.current)
          if (exact) onAutofill(exact)
        }
      })
      .catch(() => {
        if (gate.current.accepts(ticket, current.current)) setAnswer({ key, items: [] })
      })
  }

  const items = enabled && answer.key !== '' && answer.key === descriptionKey(value) ? answer.items : []
  const open = focused && !dismissed && items.length > 0

  const pick = (suggestion: DescriptionSuggestion) => {
    cancelTimer()
    gate.current.reset()
    current.current = suggestion.description
    onValueChange(suggestion.description)
    setAnswer({ key: descriptionKey(suggestion.description), items: [] })
    setDismissed(true)
    setActive(-1)
    onAutofill(suggestion)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const down = event.key === 'ArrowDown'
      setActive((i) => (down ? (i + 1 >= items.length ? 0 : i + 1) : i - 1 < 0 ? items.length - 1 : i - 1))
    } else if (event.key === 'Enter' && active >= 0 && active < items.length) {
      event.preventDefault()
      pick(items[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
    }
  }

  return (
    <div className="relative">
      <input
        type="text"
        {...inputProps}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 && active < items.length ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(event) => {
          const next = event.target.value
          current.current = next
          onValueChange(next)
          setDismissed(false)
          setActive(-1)
          cancelTimer()
          if (!enabled) return
          if (!descriptionKey(next)) {
            gate.current.reset()
            setAnswer({ key: '', items: [] })
            return
          }
          timer.current = setTimeout(() => ask(next), SUGGEST_DELAY_MS)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setActive(-1)
          if (!enabled || !descriptionKey(value)) return
          if (timer.current === null && answer.key === descriptionKey(value)) {
            const exact = exactSuggestion(answer.items, value)
            if (exact) onAutofill(exact)
            return
          }
          // The answer for this value is not in yet: ask now, and autofill when it lands.
          ask(value, true)
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Descriptions used before"
          data-testid="description-suggestions"
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto border border-line bg-surface shadow-lg"
        >
          {items.map((suggestion, index) => (
            <li
              key={suggestion.description}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-testid="description-suggestion"
              // Keeps focus in the input, so its blur does not close the list before the pick.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(suggestion)}
              className={`cursor-pointer px-3 py-3 text-sm text-body ${index === active ? 'bg-sunken' : 'hover:bg-sunken'}`}
            >
              {suggestion.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
