"use client"

import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Loading03Icon,
  MultiplicationSignCircleIcon,
} from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const toast = ToastPrimitive.createToastManager()

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />
}

/* Bottom-trailing corner. Full width on a phone (where a 24rem card floated in
   from the right reads as a misplaced dialog), a fixed column on anything
   wider. `env(safe-area-inset-*)` matters here and not in most places: the PWA
   draws under the home indicator, and this is the one surface pinned to the
   very bottom of the viewport. */
function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "pointer-events-none fixed z-50 w-auto outline-none",
        "inset-x-[max(0.75rem,env(safe-area-inset-left))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-w-md",
        "sm:right-[max(1rem,env(safe-area-inset-right))] sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:left-auto sm:mx-0 sm:w-full",
        className
      )}
      {...props}
    />
  )
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "group/toast pointer-events-auto absolute right-0 bottom-0 z-[calc(1000-var(--toast-index))] w-full origin-bottom rounded-2xl border bg-popover/95 text-popover-foreground shadow-xl ring-1 ring-black/[0.03] backdrop-blur-md will-change-transform outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:ring-white/[0.04]",
        /* Type tints. The whole card is not coloured — only the hairline and a
           wash — so an error still reads as a notification and not as a
           destructive dialog. */
        "data-[type=error]:border-destructive/30 data-[type=error]:bg-[color-mix(in_oklch,var(--popover),var(--destructive)_6%)]",
        /* The stacking machinery is Base UI's own: index-driven offset, scale
           and swipe transforms. Left as shipped — the numbers are what make a
           collapsed pile peek rather than overlap. */
        "[--gap:0.75rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.75rem] [--scale:calc(max(0,1-(var(--toast-index)*0.1)))] [--shrink:calc(1-var(--scale))]",
        "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
        "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
        "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]",
        "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
        "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className
      )}
      {...props}
    />
  )
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        // `items-start`, not `items-center`: a two-line description must not
        // drag the icon and the close button down to its middle.
        "flex h-full items-start gap-3 overflow-hidden p-3.5 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn(
        "text-sm leading-5 font-medium text-balance [overflow-wrap:anywhere]",
        className
      )}
      {...props}
    />
  )
}

/* Descriptions here carry paths, commands and server errors, so the wrapping
   rules are the load-bearing part: `anywhere` breaks a long unspaced token
   (a URL, a stack frame) instead of letting it push the card wide, and
   `pre-wrap` keeps the line breaks an error message already has. The clamp is
   the ceiling — reportError truncates at 400 chars, which is still ten lines
   in a 24rem column. */
function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn(
        "line-clamp-5 text-sm leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]",
        className
      )}
      {...props}
    />
  )
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("shrink-0", className)}
      {...props}
    />
  )
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-xs" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="Close toast"
      render={render}
      className={cn(
        "relative -mt-0.5 -mr-1 shrink-0 text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground",
        className
      )}
      {...props}
    >
      {children ?? <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" />}
    </ToastPrimitive.Close>
  )
}

const TYPE_ICONS = {
  success: { icon: CheckmarkCircle02Icon, className: "text-emerald-600 dark:text-emerald-400" },
  info: { icon: InformationCircleIcon, className: "text-foreground" },
  warning: { icon: Alert02Icon, className: "text-amber-600 dark:text-amber-400" },
  error: { icon: MultiplicationSignCircleIcon, className: "text-destructive" },
  loading: { icon: Loading03Icon, className: "animate-spin text-muted-foreground" },
} as const

function ToastIcon({ type }: { type: string | undefined }) {
  const entry = type ? TYPE_ICONS[type as keyof typeof TYPE_ICONS] : undefined
  if (!entry) return null
  return (
    <span
      data-slot="toast-icon"
      className="mt-px shrink-0 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4.5"
    >
      <HugeiconsIcon
        icon={entry.icon}
        strokeWidth={2}
        className={entry.className}
        aria-hidden="true"
      />
    </span>
  )
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager()

  return toasts.map((toastItem) => {
    /* Where the action button goes is a layout decision the toast's own
       content answers: beside a bare title it belongs inline (an "Undo" on
       one line reads as one thought), but next to a wrapping description it
       would squeeze the text into a gutter — so there it sits under it. */
    const stacked = Boolean(toastItem.description)
    return (
      <Toast key={toastItem.id} toast={toastItem}>
        <ToastContent>
          <ToastIcon type={toastItem.type} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <ToastTitle />
            <ToastDescription />
            {stacked ? <ToastAction className="mt-1.5 self-start" /> : null}
          </div>
          {stacked ? null : <ToastAction className="mt-px" />}
          <ToastClose />
        </ToastContent>
      </Toast>
    )
  })
}

function Toaster({
  children,
  toastManager = toast,
  ...props
}: ToastPrimitive.Provider.Props) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      <ToastPortal>
        <ToastViewport>
          <ToastList />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  )
}

const createToastManager = ToastPrimitive.createToastManager
const useToastManager = ToastPrimitive.useToastManager

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
}
