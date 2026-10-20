/* ── The app's toaster ──
   `components/ui/toast.tsx` is the shadcn/Base UI registry component and stays
   exactly as it ships, so a later `shadcn add toast` diffs cleanly — which is
   why this file exists at all: everything the app wants that the registry does
   not say is expressed here, as props and classNames over the registry's own
   parts. It replaces the registry's `Toaster` (whose `ToastList` is private,
   and is the one piece that has to be re-stated to restyle a row).

   Two departures from the registry's card, and the first is only spacing: the
   card's own measurements — its width, corner, type sizes, the description's
   clamp, the button sizes — are the registry's untouched. What is tightened is
   the air between them: the padding, the gap from the icon to the text, the gap
   from the title to the description, and the gap and peek of the collapsed
   pile. A toast is a headline with a hint under it, and at the registry's
   spacing that content sat in a card noticeably larger than the sentence in it.

   TOP ON A PHONE. The registry's card is bottom-trailing, which is right on a
   desktop and wrong on a phone: the bottom of the viewport is where the
   composer, the send button and the home indicator are, so a card pinned there
   lands under the thumb and over the control the user is reaching for. On a
   phone it comes from the top instead. That is not a `top-*` class — the
   registry's stack is *anchored* to the bottom (offsets, peek, scale
   compensation and every enter/exit transform point down), so flipping it means
   mirroring the whole set: `--offset-y` and the collapsed transform change
   sign, the enter/exit translate is negative, the gap filler moves to
   `bottom-full`, and the swipe that dismisses becomes up rather than down.

   Which of the two is decided by `useIsMobile` — the window, not a container:
   a toast is viewport-anchored, so the window is genuinely what it is measured
   against — and by JS rather than a `max-sm:` variant, because these overrides
   have to *replace* the registry's classes through `cn`'s tailwind-merge, which
   only collapses a conflict when the modifiers match. */
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Loading03Icon,
  MultiplicationSignCircleIcon,
  Notification03Icon,
} from "@hugeicons/core-free-icons"

import { useIsMobile } from "@/hooks/use-device"
import { cn } from "@/lib/utils"
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  toast,
  useToastManager,
} from "@/components/ui/toast"
import type { Toast as ToastPrimitive } from "@base-ui/react/toast"

/* Pinned to the top inset instead of the bottom one. The `sm:` half is restated
   so the switch is whole: `useIsMobile` breaks at 768px and the registry's own
   desktop rules at 640px, so between the two a viewport that only dropped the
   unprefixed `bottom` would still be holding the `sm:` one and stretch to both
   edges. */
const VIEWPORT_TOP =
  "top-[max(0.75rem,env(safe-area-inset-top))] bottom-auto sm:top-[max(1rem,env(safe-area-inset-top))] sm:bottom-auto"

/* A shallower pile: the registry's 0.75rem gap and peek are the one piece of
   spacing that lives on the card rather than inside it. */
const TOAST_TIGHT = "[--gap:0.5rem] [--peek:0.5rem]"

/* The mirror of the registry's bottom-anchored stack. Every string whose
   modifiers match one of its own replaces that one through tailwind-merge. */
const TOAST_TOP = [
  "top-0 bottom-auto origin-top",
  "[--offset-y:calc(var(--toast-offset-y)+calc(var(--toast-index)*var(--gap))+var(--toast-swipe-movement-y))]",
  "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--peek))+(var(--shrink)*var(--height))))_scale(var(--scale))]",
  "after:top-auto after:bottom-full",
  "data-starting-style:[transform:translateY(-150%)]",
  "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(-150%)]",
].join(" ")

/* Down is the registry's dismissing swipe because its card sits at the bottom;
   from the top it is up, and sideways stays as it is. */
const SWIPE_TOP: ToastPrimitive.Root.Props["swipeDirection"] = ["up", "right"]

/* Every toast wears an icon, so an untyped `toast("…")` gets the neutral bell
   rather than a bare title — the icon is what makes the header a header. */
const TYPE_ICONS = {
  default: { icon: Notification03Icon, className: "text-muted-foreground" },
  success: { icon: CheckmarkCircle02Icon, className: "text-success" },
  info: { icon: InformationCircleIcon, className: "text-foreground" },
  warning: { icon: Alert02Icon, className: "text-warning" },
  error: { icon: MultiplicationSignCircleIcon, className: "text-destructive" },
  loading: { icon: Loading03Icon, className: "animate-spin text-muted-foreground" },
} as const

function ToastIcon({ type }: { type: string | undefined }) {
  const entry = TYPE_ICONS[(type ?? "default") as keyof typeof TYPE_ICONS] ?? TYPE_ICONS.default
  return (
    <span className="flex h-5 shrink-0 items-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4">
      <HugeiconsIcon icon={entry.icon} strokeWidth={2} className={entry.className} aria-hidden="true" />
    </span>
  )
}

/* One shape for every toast: a header (icon + title, close at the end), the
   description under it aligned with the title, and an action row at the foot —
   drawn only when the toast carries an action, so a plain "Copied" stays one
   line and never grows an empty footer. */
function ToastList({ top }: { top: boolean }) {
  const { toasts } = useToastManager()

  return toasts.map((toastItem) => (
    <Toast
      key={toastItem.id}
      toast={toastItem}
      className={cn(TOAST_TIGHT, top && TOAST_TOP)}
      swipeDirection={top ? SWIPE_TOP : undefined}
    >
      <ToastContent className="flex-col items-stretch gap-1 p-3">
        <div className="flex items-start gap-2">
          <ToastIcon type={toastItem.type} />
          <ToastTitle className="min-w-0 flex-1 leading-5" />
          <ToastClose className="-my-1 -me-1" />
        </div>
        {toastItem.description ? <ToastDescription className="ps-6" /> : null}
        {toastItem.actionProps ? (
          <div className="mt-1.5 flex justify-end gap-2">
            <ToastAction />
          </div>
        ) : null}
      </ToastContent>
    </Toast>
  ))
}

export function AppToaster({
  children,
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props) {
  const top = useIsMobile()
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport className={top ? VIEWPORT_TOP : undefined}>
          <ToastList top={top} />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}
