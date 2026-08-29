import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

/* One modal API: a centered Dialog on desktop, a bottom-sheet Drawer on mobile.
   The mobile flag flows through context so every part picks its counterpart
   without prop drilling, and the parts mirror the base Dialog/Drawer parts so
   styling and behavior stay consistent with the rest of the UI.

   Layout invariant: header and footer are `shrink-0` so they keep their size,
   while the body is collected into a single `flex-1 min-h-0 overflow-y-auto`
   region that scrolls between them. No sticky positioning, so a short dialog
   (header + footer, no body) collapses to exactly its content instead of
   leaving a stray band of padding. */

const MobileCtx = React.createContext(false)

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
  const Root = isMobile ? Drawer : Dialog
  return (
    <MobileCtx.Provider value={isMobile}>
      <Root open={open} onOpenChange={onOpenChange}>
        {children}
      </Root>
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

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const isMobile = React.useContext(MobileCtx)
  const { header, body, footer } = partitionChildren(children)

  if (isMobile) {
    return (
      <DrawerContent>
        {/* Header and footer stay put (shrink-0); only this region scrolls. */}
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4">
          {body}
        </div>
        {footer}
      </DrawerContent>
    )
  }

  return (
    <DialogContent
      /* Bounded height + internal scroll: base DialogContent's `grid gap-6`
         and `p-6` are dropped so the panel becomes a flex column whose body
         region scrolls. Widths stay `sm:`-prefixed so tailwind-merge resolves
         the base `sm:max-w-md`. */
      className={cn(
        "flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg",
        className
      )}
      {...props}
    >
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6">
        {body}
      </div>
      {footer}
    </DialogContent>
  )
}

function ResponsiveDialogHeader({
  className,
  children,
  ...props
}: React.ComponentProps<"header">) {
  const isMobile = React.useContext(MobileCtx)
  if (isMobile) {
    return (
      <DrawerHeader
        className={cn(
          "shrink-0 gap-1 border-b border-border/60 px-4 py-4 pr-14 text-left",
          className
        )}
        {...props}
      >
        {children}
        <DrawerClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-3.5 right-3 text-muted-foreground hover:text-foreground"
            />
          }
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          <span className="sr-only">Close</span>
        </DrawerClose>
      </DrawerHeader>
    )
  }
  return (
    <DialogHeader
      className={cn(
        "shrink-0 gap-1.5 border-b border-border/60 px-6 py-5 pr-14",
        className
      )}
      {...props}
    >
      {children}
    </DialogHeader>
  )
}

function ResponsiveDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = React.useContext(MobileCtx)
  // Mirrors base DialogTitle / DrawerTitle typography.
  const titleClassName = cn("font-heading text-base font-medium", className)
  return isMobile ? (
    <DrawerTitle className={titleClassName} {...props} />
  ) : (
    <DialogTitle className={titleClassName} {...props} />
  )
}

function ResponsiveDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = React.useContext(MobileCtx)
  // Mirrors base DialogDescription / DrawerDescription typography.
  const descriptionClassName = cn("text-sm text-muted-foreground", className)
  return isMobile ? (
    <DrawerDescription className={descriptionClassName} {...props} />
  ) : (
    <DialogDescription className={descriptionClassName} {...props} />
  )
}

function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<"footer">) {
  const isMobile = React.useContext(MobileCtx)
  if (isMobile) {
    return (
      <DrawerFooter
        className={cn(
          "shrink-0 gap-2 border-t border-border/60 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
          className
        )}
        {...props}
      />
    )
  }
  return (
    <DialogFooter
      className={cn(
        "shrink-0 gap-2 border-t border-border/60 px-6 py-4",
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
