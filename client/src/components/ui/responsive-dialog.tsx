import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

/* One modal API: a centred dialog on desktop, a bottom sheet on a phone.

   Built straight on the Base UI Dialog/Drawer primitives rather than on the
   shadcn `Dialog`/`Drawer` wrappers, because the two wrappers paint different
   surfaces: the dialog popup is `data-slot="dialog-content"`, which index.css
   turns into frosted glass (translucent background, blur, glass shadow), while
   the drawer popup is `data-slot="drawer-popup"` with an opaque `bg-popover`
   and a border that no rule touches — so the sheet never looked like the
   dialog. Here both popups carry the *same* slot and the same `SURFACE`
   classes, and the backdrop is the same slot on both sides too, so the glass
   rules apply once and the two can no longer drift.

   Layout invariant: header and footer are `shrink-0`, and everything between
   them is collected into one `min-h-0 flex-1 overflow-y-auto` region — the
   only part that scrolls. No sticky positioning, so a dialog with no body
   collapses to exactly header + footer. */

const MobileCtx = React.createContext(false)

/* The panel: shared by the centred popup and the sheet. `data-slot` is what
   index.css keys the glass background/blur/shadow on. */
const SURFACE =
  "text-sm text-popover-foreground bg-popover ring-1 ring-foreground/5 outline-none"

/* The backdrop tint lives in index.css under [data-slot="dialog-overlay"]. */
const OVERLAY = "fixed inset-0 isolate z-50 bg-black/80 supports-backdrop-filter:backdrop-blur-xs"

/* Distance the sheet floats off the screen edge. */
const SHEET_INSET = "[--drawer-inset:--spacing(2)]"

function ResponsiveDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  const isMobile = useIsMobile()
  return (
    <MobileCtx.Provider value={isMobile}>
      {isMobile ? (
        <DrawerPrimitive.Root
          data-slot="responsive-dialog"
          open={open}
          onOpenChange={onOpenChange}
          modal
          swipeDirection="down"
        >
          {children}
        </DrawerPrimitive.Root>
      ) : (
        <DialogPrimitive.Root data-slot="responsive-dialog" open={open} onOpenChange={onOpenChange}>
          {children}
        </DialogPrimitive.Root>
      )}
    </MobileCtx.Provider>
  )
}

/* Pull the header and footer out of the children so the body in between can be
   wrapped in the single scroll region the layout invariant needs. */
function partitionChildren(children: React.ReactNode) {
  const all = React.Children.toArray(children)
  const headerIndex = all.findIndex(
    (child) => React.isValidElement(child) && child.type === ResponsiveDialogHeader
  )
  const footerIndex = all.findIndex(
    (child) => React.isValidElement(child) && child.type === ResponsiveDialogFooter
  )
  const header = headerIndex >= 0 ? all[headerIndex] : null
  const footer = footerIndex >= 0 ? all[footerIndex] : null
  const body = all.filter((_, index) => index !== headerIndex && index !== footerIndex)
  return { header, body, footer }
}

function CloseButton({ Close }: { Close: typeof DialogPrimitive.Close | typeof DrawerPrimitive.Close }) {
  return (
    <Close
      data-slot="dialog-close"
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
        />
      }
    >
      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      <span className="sr-only">Close</span>
    </Close>
  )
}

/* Plain div props: the two popups' `render`/`className` state types differ, and
   nothing here needs the state-driven forms. */
type ContentProps = Omit<
  React.ComponentPropsWithoutRef<"div">,
  "className" | "style" | "color" | "children"
> & {
  className?: string
  /* The scroll region between header and footer. An escape hatch, not a second
     layout: a body that is itself two scrolling panes (the workflow run's
     sidebar + step pane) has to turn the outer region's padding and its
     `overflow-y-auto` off, or the inner panes can never own their own scroll.
     Merged last, so `p-0 overflow-hidden` wins over the defaults. */
  bodyClassName?: string
  children?: React.ReactNode
}

function ResponsiveDialogContent({ className, bodyClassName, children, ...props }: ContentProps) {
  const isMobile = React.useContext(MobileCtx)
  const { header, body, footer } = partitionChildren(children)

  if (isMobile) {
    return (
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Backdrop
          data-slot="dialog-overlay"
          className={cn(
            OVERLAY,
            "min-h-dvh select-none opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)]",
            "data-starting-style:opacity-0 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-swiping:duration-0",
            "supports-[-webkit-touch-callout:none]:absolute"
          )}
        />
        <DrawerPrimitive.Viewport
          data-slot="responsive-dialog-viewport"
          className="fixed inset-0 z-50 select-none"
        >
          <DrawerPrimitive.Popup
            data-slot="dialog-content"
            className={cn(
              SURFACE,
              SHEET_INSET,
              // A sheet floating off the bottom edge, following the finger.
              "fixed inset-x-0 bottom-0 z-50 m-(--drawer-inset) flex max-h-[calc(100dvh-6rem)] min-h-0 origin-bottom flex-col rounded-4xl select-none",
              "transform-[translate3d(0,var(--drawer-swipe-movement-y),0)] will-change-transform",
              "[--closed-transform:translate3d(0,calc(100%+var(--drawer-inset)+2px),0)]",
              "transition-[transform,opacity] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)]",
              "data-starting-style:transform-(--closed-transform) data-ending-style:transform-(--closed-transform) data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-swiping:duration-0",
              className
            )}
            {...props}
          >
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30"
            />
            <DrawerPrimitive.Content className="flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain rounded-[inherit] select-text">
              {header}
              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 py-4",
                  !footer && "pb-[max(1rem,env(safe-area-inset-bottom))]",
                  bodyClassName
                )}
              >
                {body}
              </div>
              {footer}
            </DrawerPrimitive.Content>
            <CloseButton Close={DrawerPrimitive.Close} />
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Viewport>
      </DrawerPrimitive.Portal>
    )
  }

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-overlay"
        className={cn(
          OVERLAY,
          "duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        )}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          SURFACE,
          "fixed top-1/2 left-1/2 z-50 flex max-h-[85svh] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-4xl sm:max-w-lg",
          "duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {header}
        <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5", bodyClassName)}>{body}</div>
        {footer}
        <CloseButton Close={DialogPrimitive.Close} />
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function ResponsiveDialogHeader({ className, ...props }: React.ComponentProps<"header">) {
  const isMobile = React.useContext(MobileCtx)
  return (
    <header
      data-slot="dialog-header"
      className={cn(
        "flex shrink-0 flex-col gap-1.5 border-b border-border/60 pr-14 text-left",
        isMobile ? "px-4 py-4" : "px-6 py-5",
        className
      )}
      {...props}
    />
  )
}

function ResponsiveDialogFooter({ className, ...props }: React.ComponentProps<"footer">) {
  const isMobile = React.useContext(MobileCtx)
  return (
    <footer
      data-slot="dialog-footer"
      className={cn(
        "flex shrink-0 gap-2 border-t border-border/60",
        isMobile
          ? "flex-col px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          : "flex-row justify-end px-6 py-4",
        className
      )}
      {...props}
    />
  )
}

function ResponsiveDialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  const isMobile = React.useContext(MobileCtx)
  const Title = isMobile ? DrawerPrimitive.Title : DialogPrimitive.Title
  return (
    <Title
      data-slot="dialog-title"
      className={cn("font-heading text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function ResponsiveDialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  const isMobile = React.useContext(MobileCtx)
  const Description = isMobile ? DrawerPrimitive.Description : DialogPrimitive.Description
  return (
    <Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
}
