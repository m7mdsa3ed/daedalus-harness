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
import { X } from "lucide-react"

/* One modal API: a Dialog on desktop, a bottom Drawer on mobile.
   Parts mirror the Dialog parts; the mobile flag flows through context so
   every part picks its counterpart without prop drilling. */

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

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const isMobile = React.useContext(MobileCtx)
  if (isMobile) {
    /* The drawer sizes itself from its own CSS vars and its inner Content is a
       flex column with overflow-hidden — so the scroll region has to be
       `flex-1 min-h-0`, or a tall form is clipped with no way to reach the
       buttons. `className` is desktop sizing (max-w/max-h/overflow): on a bottom
       sheet it left-aligns the panel and fights those vars, so it stays behind. */
    return (
      <DrawerContent>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </DrawerContent>
    )
  }
  /* Width has to be set at the `sm:` breakpoint: DialogContent's own
     `sm:max-w-sm` beats any plain `max-w-*` a caller passes, so widths given
     here (and by callers) are all `sm:`-prefixed for tailwind-merge to resolve. */
  return (
    <DialogContent
      className={cn("max-h-[85svh] overflow-y-auto sm:max-w-lg", className)}
      {...props}
    >
      {children}
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
          "sticky top-0 z-20 -mx-4 gap-1 border-b border-border/60 bg-popover/95 px-4 py-4 pr-14 group-data-[swipe-axis=y]/drawer-popup:text-left supports-backdrop-filter:backdrop-blur-xl",
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
          <X />
          <span className="sr-only">Close</span>
        </DrawerClose>
      </DrawerHeader>
    )
  }
  return (
    <DialogHeader
      className={cn(
        "sticky -top-6 z-20 -mx-6 -mt-6 gap-1.5 border-b border-border/60 bg-popover/95 px-6 py-5 pr-14 supports-backdrop-filter:backdrop-blur-xl",
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
  const titleClassName = cn("text-lg leading-tight font-semibold", className)
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
  const descriptionClassName = cn("max-w-[65ch] leading-relaxed", className)
  return isMobile ? (
    <DrawerDescription className={descriptionClassName} {...props} />
  ) : (
    <DialogDescription className={descriptionClassName} {...props} />
  )
}

function ResponsiveDialogFooter({ className, ...props }: React.ComponentProps<"footer">) {
  const isMobile = React.useContext(MobileCtx)
  return isMobile ? (
    <DrawerFooter
      className={cn(
        "sticky bottom-[calc(-1*max(1rem,env(safe-area-inset-bottom)))] z-20 -mx-4 -mb-[max(1rem,env(safe-area-inset-bottom))] mt-2 border-t border-border/60 bg-popover/95 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] supports-backdrop-filter:backdrop-blur-xl",
        className
      )}
      {...props}
    />
  ) : (
    <DialogFooter
      className={cn(
        "sticky -bottom-6 z-20 -mx-6 -mb-6 mt-2 border-t border-border/60 bg-popover/95 px-6 py-4 supports-backdrop-filter:backdrop-blur-xl",
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
