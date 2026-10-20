/* ── The shortcut sheet ──
   Rendered straight from lib/shortcuts' table, never from a second list of
   strings: a key that stops being bound has to disappear from here by itself.
   Opened with ? (or mod+/) and from the command palette. */
import * as React from "react"
import { SlidersHorizontalIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { Button } from "@/components/ui/button"

import { Shortcut } from "@/components/shortcut"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useShortcut } from "@/hooks/use-hotkey"
import { useChords } from "@/lib/keybindings"
import {
  isTypingTarget,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  type ShortcutDef,
} from "@/lib/shortcuts"

/** Open state + the ? binding, so the shell only has to render the sheet.
    Mirrors useCommandPalette. */
export function useShortcutsHelp() {
  const [open, setOpen] = React.useState(false)

  useShortcut("help", (event) => {
    // "?" is a character before it is a command — typing one into a prompt must
    // not open a dialog over the thing you are typing. Declining the key rather
    // than returning quietly is what leaves the character in the box.
    if (!(event.metaKey || event.ctrlKey) && isTypingTarget(event.target)) return false
    setOpen((previous) => !previous)
  })

  return { open, setOpen }
}

function Row({ shortcut }: { shortcut: ShortcutDef }) {
  /* The reader's own chords, so a rebinding shows up here rather than leaving
     the sheet advertising a key that no longer does anything. `display` still
     wins where the real binding is a range (1…9) that no chord spells. */
  const bound = useChords(shortcut.id)
  const chords = shortcut.display ?? bound
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className="text-sm leading-snug">{shortcut.label}</p>
        {shortcut.note && (
          <p className="mt-0.5 text-xs leading-snug text-pretty text-muted-foreground">
            {shortcut.note}
          </p>
        )}
      </div>
      {/* Alternatives read as alternatives, not as a sequence to press. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {chords.map((chord, index) => (
          <React.Fragment key={chord}>
            {index > 0 && <span className="text-xs text-muted-foreground">or</span>}
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
  const navigate = useNavigate()
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Keyboard shortcuts</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Thread keys apply to the transcript you are looking at.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* The content element already scrolls (dialog) or is the scroll region
            (drawer) — a second one here would trap the wheel inside it. */}
        {SHORTCUT_SCOPES.map((scope) => {
          const rows = SHORTCUTS.filter((shortcut) => shortcut.scope === scope)
          if (rows.length === 0) return null
          return (
            <section key={scope}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                {scope}
              </h3>
              <div className="divide-y">
                {rows.map((shortcut) => (
                  <Row key={`${scope}:${shortcut.label}`} shortcut={shortcut} />
                ))}
              </div>
            </section>
          )
        })}
        {/* The sheet says what the keys are; changing them is a page, not a
            dialog — one link rather than an editor inside a reference. */}
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => {
              onOpenChange(false)
              void navigate("/settings/keyboard")
            }}
          >
            <SlidersHorizontalIcon data-icon="inline-start" />
            Change these shortcuts
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
