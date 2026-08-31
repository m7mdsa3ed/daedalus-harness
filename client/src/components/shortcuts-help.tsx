/* ── The shortcut sheet ──
   Rendered straight from lib/shortcuts' table, never from a second list of
   strings: a key that stops being bound has to disappear from here by itself.
   Opened with ? (or mod+/) and from the command palette. */
import * as React from "react"

import { Shortcut } from "@/components/shortcut"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useHotkey } from "@/hooks/use-hotkey"
import {
  isTypingTarget,
  KEYS,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  type ShortcutDef,
} from "@/lib/shortcuts"

/** Open state + the ? binding, so the shell only has to render the sheet.
    Mirrors useCommandPalette. */
export function useShortcutsHelp() {
  const [open, setOpen] = React.useState(false)

  useHotkey(
    KEYS.help,
    (event) => {
      // "?" is a character before it is a command — typing one into a prompt
      // must not open a dialog over the thing you are typing.
      if (!(event.metaKey || event.ctrlKey) && isTypingTarget(event.target)) return
      event.preventDefault()
      setOpen((previous) => !previous)
    }
  )

  return { open, setOpen }
}

function Row({ shortcut }: { shortcut: ShortcutDef }) {
  const chords = shortcut.display ?? shortcut.chords
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className="text-[13px] leading-snug">{shortcut.label}</p>
        {shortcut.note && (
          <p className="mt-0.5 text-[11px] leading-snug text-pretty text-muted-foreground">
            {shortcut.note}
          </p>
        )}
      </div>
      {/* Alternatives read as alternatives, not as a sequence to press. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {chords.map((chord, index) => (
          <React.Fragment key={chord}>
            {index > 0 && <span className="text-[11px] text-muted-foreground">or</span>}
            <Shortcut chord={chord} />
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

export function ShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Keyboard shortcuts</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Thread keys apply to the transcript you are looking at.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* The content element already scrolls (dialog) or is the scroll region
            (drawer) — a second one here would trap the wheel inside it. */}
        <div className="pt-1">
          {SHORTCUT_SCOPES.map((scope) => {
            const rows = SHORTCUTS.filter((shortcut) => shortcut.scope === scope)
            if (rows.length === 0) return null
            return (
              <section key={scope} className="mb-3 last:mb-0">
                <h3 className="mb-1 text-[10px] font-medium tracking-widest text-muted-foreground uppercase">
                  {scope}
                </h3>
                <div className="divide-y divide-border/40">
                  {rows.map((shortcut) => (
                    <Row key={`${scope}:${shortcut.label}`} shortcut={shortcut} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
