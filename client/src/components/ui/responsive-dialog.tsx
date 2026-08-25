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
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

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

function ResponsiveDialogHeader(props: React.ComponentProps<"div">) {
  const isMobile = React.useContext(MobileCtx)
  return isMobile ? <DrawerHeader className="px-0" {...props} /> : <DialogHeader {...props} />
}

function ResponsiveDialogTitle(props: React.ComponentProps<typeof DialogTitle>) {
  const isMobile = React.useContext(MobileCtx)
  return isMobile ? <DrawerTitle {...props} /> : <DialogTitle {...props} />
}

function ResponsiveDialogDescription(props: React.ComponentProps<typeof DialogDescription>) {
  const isMobile = React.useContext(MobileCtx)
  return isMobile ? <DrawerDescription {...props} /> : <DialogDescription {...props} />
}

function ResponsiveDialogFooter(props: React.ComponentProps<"div">) {
  const isMobile = React.useContext(MobileCtx)
  return isMobile ? <DrawerFooter className="px-0" {...props} /> : <DialogFooter {...props} />
}

export {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
}
