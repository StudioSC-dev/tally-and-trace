import { swatchOf } from '../utils/palette'

/**
 * The custom colour choice beside the swatches. It is an outlined, empty box (`line-strong`) until a colour that is
 * not one of the swatches is set, then it shows that colour. The native colour input sits over the box, unseen,
 * and keeps the accessible name.
 */
export function CustomColourInput({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <span
      data-testid="custom-swatch"
      className="relative inline-block h-7 w-10 border border-line-strong focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink"
      style={{ backgroundColor: swatchOf(value) === null ? value : 'transparent' }}
    >
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label="Custom colour" />
    </span>
  )
}
