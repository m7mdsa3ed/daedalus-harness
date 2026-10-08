import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, m, MotionConfig } from "motion/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/* A reader that grows out of the thing it reads. Adapted from motion-primitives'
   `morphing-dialog` (shadcn registry): the source and the panel share one
   `layoutId`, and motion animates the one box into the other.

   What differs from the registry's version, and why:
   - the source is a `div`, not a `button` — the things that morph here (a run's
     card, a flowchart) hold buttons of their own, and the opener is a separate
     `MorphingDialogOpen`;
   - the panel is inset from the window, not edge to edge, and wears the app's
     own `dialog-content` / `dialog-overlay` slots, so it is the same glass as
     every other dialog;
   - the backdrop closes it (the registry's click-outside listened on the
     document, which a popover portalled out of the panel would have tripped);
   - `m`, not `motion`: the app mounts `LazyMotion strict` with `domMax`, which
     is what carries `layout`.

   Not a form surface: a reader. One panel per `MorphingDialog`, state inside. */

type Ctx = {
  open: boolean
  setOpen: (open: boolean) => void
  layoutId: string
  openerRef: React.RefObject<HTMLButtonElement | null>
}

const MorphingDialogContext = React.createContext<Ctx | null>(null)

function useMorphingDialog() {
  const ctx = React.useContext(MorphingDialogContext)
  if (!ctx) throw new Error("MorphingDialog parts must sit inside <MorphingDialog>")
  return ctx
}

function MorphingDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const layoutId = `morph-${React.useId()}`
  const openerRef = React.useRef<HTMLButtonElement>(null)
  const value = React.useMemo(() => ({ open, setOpen, layoutId, openerRef }), [open, layoutId])
  return (
    <MorphingDialogContext.Provider value={value}>
      <MotionConfig reducedMotion="user" transition={{ type: "spring", duration: 0.4, bounce: 0.05 }}>
        {children}
      </MotionConfig>
    </MorphingDialogContext.Provider>
  )
}

/** The box that opens into the panel. Stays mounted and in the flow while the
    panel is up, so nothing around it moves under the morph. */
function MorphingDialogSource({ className, children }: { className?: string; children: React.ReactNode }) {
  const { layoutId } = useMorphingDialog()
  return (
    <m.div layoutId={layoutId} className={className}>
      {children}
    </m.div>
  )
}

function MorphingDialogOpen({
  className,
  title,
  children,
}: {
  className?: string
  title: string
  children: React.ReactNode
}) {
  const { open, setOpen, openerRef } = useMorphingDialog()
  return (
    <button
      ref={openerRef}
      type="button"
      title={title}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
      className={className}
    >
      {children}
    </button>
  )
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

function MorphingDialogContent({
  label,
  className,
  children,
}: {
  /** The dialog's accessible name. */
  label: string
  className?: string
  children: React.ReactNode
}) {
  const { open, setOpen, layoutId, openerRef } = useMorphingDialog()
  const panelRef = React.useRef<HTMLDivElement>(null)

  /* Escape closes, Tab stays inside, focus goes in on open and back to the
     opener on close. */
  React.useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    panel?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) return setOpen(false)
      if (event.key !== "Tab" || !panel) return
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE)
      const first = items[0]
      const last = items[items.length - 1]
      if (!first) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      openerRef.current?.focus()
    }
  }, [open, setOpen, openerRef])

  return createPortal(
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          key="backdrop"
          data-slot="dialog-overlay"
          className="fixed inset-0 isolate z-50 bg-black/80 supports-backdrop-filter:backdrop-blur-xs"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => setOpen(false)}
        />
      )}
      {open && (
        /* Inset from the window, not edge to edge. The wrapper lets clicks
           through to the backdrop; only the panel takes them. */
        <div key="panel" className="pointer-events-none fixed inset-0 z-50 p-2 sm:p-6">
          <m.div
            ref={panelRef}
            layoutId={layoutId}
            data-slot="dialog-content"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            /* The radius is a style, not a class: it is what motion corrects
               while it scales the box, so the corners do not stretch. */
            style={{ borderRadius: 16 }}
            className={cn(
              "pointer-events-auto relative flex size-full flex-col overflow-hidden bg-popover text-sm text-popover-foreground ring-1 ring-foreground/5 outline-none",
              className
            )}
          >
            {/* The box is scaled from the source's rect while it lands, which
                would stretch what is inside — so the inside arrives after. */}
            <m.div
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.12, duration: 0.2 } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
            >
              {children}
            </m.div>
            <Button
              data-slot="dialog-close"
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              <span className="sr-only">Close</span>
            </Button>
          </m.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}

export { MorphingDialog, MorphingDialogSource, MorphingDialogOpen, MorphingDialogContent }
