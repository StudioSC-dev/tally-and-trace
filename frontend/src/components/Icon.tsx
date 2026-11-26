import type { Icon as PhosphorIcon } from '@phosphor-icons/react/dist/lib/types'
import { ArrowsLeftRightIcon } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight'
import { BankIcon } from '@phosphor-icons/react/dist/csr/Bank'
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft'
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight'
import { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp'
import { ChartLineIcon } from '@phosphor-icons/react/dist/csr/ChartLine'
import { ChartPieSliceIcon } from '@phosphor-icons/react/dist/csr/ChartPieSlice'
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check'
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle'
import { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical'
import { EnvelopeIcon } from '@phosphor-icons/react/dist/csr/Envelope'
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye'
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash'
import { FunnelIcon } from '@phosphor-icons/react/dist/csr/Funnel'
import { GearIcon } from '@phosphor-icons/react/dist/csr/Gear'
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House'
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { MoonIcon } from '@phosphor-icons/react/dist/csr/Moon'
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause'
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple'
import { PiggyBankIcon } from '@phosphor-icons/react/dist/csr/PiggyBank'
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play'
import { ReceiptIcon } from '@phosphor-icons/react/dist/csr/Receipt'
import { SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut'
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun'
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash'
import { UserPlusIcon } from '@phosphor-icons/react/dist/csr/UserPlus'
import { WalletIcon } from '@phosphor-icons/react/dist/csr/Wallet'
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning'
import { WarningOctagonIcon } from '@phosphor-icons/react/dist/csr/WarningOctagon'
import { XIcon } from '@phosphor-icons/react/dist/csr/X'
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle'

/**
 * The app's one icon set (docs/design-system.md, Icons): Phosphor Regular, 20px, drawn in `currentColor`. Each icon is
 * named for what it means, not for its shape, and imported on its own so the bundle carries only these.
 */
const ICONS = {
  accounts: BankIcon,
  allocations: WalletIcon,
  budget: EnvelopeIcon,
  'caret-down': CaretDownIcon,
  'caret-left': CaretLeftIcon,
  'caret-right': CaretRightIcon,
  'caret-up': CaretUpIcon,
  check: CheckIcon,
  close: XIcon,
  delete: TrashIcon,
  'drag-handle': DotsSixVerticalIcon,
  edit: PencilSimpleIcon,
  error: XCircleIcon,
  'external-link': ArrowUpRightIcon,
  filter: FunnelIcon,
  forecast: ChartLineIcon,
  hide: EyeSlashIcon,
  home: HouseIcon,
  info: InfoIcon,
  overdue: WarningOctagonIcon,
  pause: PauseIcon,
  play: PlayIcon,
  receipt: ReceiptIcon,
  'requirement-unmet': CircleIcon,
  savings: PiggyBankIcon,
  search: MagnifyingGlassIcon,
  settings: GearIcon,
  show: EyeIcon,
  'sign-out': SignOutIcon,
  'sign-up': UserPlusIcon,
  'spending-breakdown': ChartPieSliceIcon,
  success: CheckCircleIcon,
  'theme-dark': MoonIcon,
  'theme-light': SunIcon,
  transactions: ArrowsLeftRightIcon,
  warning: WarningIcon,
} satisfies Record<string, PhosphorIcon>

export type IconName = keyof typeof ICONS

/**
 * One icon. Weight, size and colour are fixed here and callers cannot change them: a caller colours an icon by the
 * text colour of its parent. Every icon is decorative (`aria-hidden`); an icon-only button or link carries its own
 * `aria-label`. `shrink-0` keeps a flex row from squeezing it, and `inline-block` keeps it on the text line it sits in.
 * `data-icon` names the icon for tests.
 */
export function Icon({ name }: { name: IconName }) {
  const Glyph = ICONS[name]
  return (
    <Glyph
      weight="regular"
      size={20}
      color="currentColor"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      className="inline-block shrink-0 align-middle"
    />
  )
}
