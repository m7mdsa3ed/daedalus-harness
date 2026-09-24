/* ── Settings › Keyboard ──
   Every binding the app has, on one page, with the two things a rebinding
   actually needs: a chord, and an answer to "and what about whatever else
   wanted that key".

   The list is `SHORTCUTS` itself, never a second table — a key that stops being
   bound disappears from here on its own, which is the rule the help sheet was
   already written to. Rows that are not `rebindable` are still listed: Enter
   sends and Escape backs out, and a page of shortcuts that quietly omitted them
   would read as an incomplete list rather than as a deliberate one.

   The recorder is a dialog rather than an input that listens in place, because
   while it is recording *every* chord belongs to it — ⌘K must be captured, not
   open the palette — and a dialog is the one surface where "the whole keyboard
   is mine for a moment" is legible. It captures on keydown at the capture phase
   for the same reason.

   Warnings are shown before the chord is saved and again on the row afterwards,
   because the two questions differ: choosing is "do you want this", living with
   it is "why is this one not firing". */
import * as React from "react"
import { AlertTriangleIcon, InfoIcon, KeyboardIcon, RotateCcwIcon } from "lucide-react"

import { useCoarsePointer } from "@/hooks/use-device"
import { Shortcut } from "@/components/shortcut"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/confirm-dialog"
import {
  chordWarnings,
  isCustomized,
  resetAllShortcuts,
  resetShortcut,
  setShortcutChords,
  setShortcutOverride,
  useKeybindings,
  type ChordWarning,
} from "@/lib/keybindings"
import {
  chordFromEvent,
  formatChord,
  reservedChord,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/ui/copy-button"
import { Notice } from "@/components/notice"
import { QUICK_ENTRY_DEFAULT, useQuickEntry } from "@/lib/desktop"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"

/** The desktop shell is the one place a browser-reserved chord is free: the
    page is the whole window, so nothing above it claims ⌘N first. */
const DESKTOP = typeof window !== "undefined" && !!window.desktop?.isElectron

function WarningLine({ warning }: { warning: ChordWarning }) {
  const hard = warning.kind === "hard"
  // A span, not a p: these are rendered inside Row's `subtitle`, which is
  // already inside a block of text.
  return (
    <span
      className={cn(
        "flex items-start gap-1.5 text-[11px] leading-snug",
        hard ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {hard ? (
        <AlertTriangleIcon className="mt-px size-3 shrink-0" />
      ) : (
        <InfoIcon className="mt-px size-3 shrink-0" />
      )}
      <span className="text-pretty">{warning.text}</span>
    </span>
  )
}

/** The recorder. Open, press the chord, read what it will cost, save. */
function RecordDialog({
  shortcut,
  open,
  onOpenChange,
}: {
  shortcut: ShortcutDef | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [chord, setChord] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) setChord(null)
  }, [open, shortcut?.id])

  /* Capture phase on the window: while this is open the keyboard belongs to the
     recorder, so a chord the app itself binds is written down rather than
     obeyed. Escape and Tab are the two exceptions — leaving and moving focus
     have to keep working, or a recorder opened by accident is a trap. */
  React.useEffect(() => {
    if (!open || !shortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") return
      event.preventDefault()
      event.stopPropagation()
      const next = chordFromEvent(event)
      if (next) setChord(next)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open, shortcut])

  if (!shortcut) return null
  const warnings = chord ? chordWarnings(chord, shortcut.id, DESKTOP) : []

  const save = () => {
    if (!chord) return
    setShortcutChords(shortcut.id, [chord])
    onOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="@panel-sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{shortcut.label}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Press the keys you want. Escape closes this without changing anything.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="pb-2">
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border border-dashed",
              chord ? "border-primary/40 bg-primary/5" : "bg-muted/30"
            )}
          >
            {chord ? (
              <Shortcut chord={chord} keyClassName="h-7 min-w-7 text-sm" />
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for a key…</p>
            )}
          </div>
          {warnings.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {warnings.map((warning) => (
                <WarningLine key={warning.kind + warning.text} warning={warning} />
              ))}
            </div>
          )}
        </div>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!chord} onClick={save}>
            Use this chord
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function ShortcutRow({
  shortcut,
  chords,
  override,
  onRecord,
}: {
  shortcut: ShortcutDef
  chords: string[]
  override: boolean
  onRecord: () => void
}) {
  /* The pointer, not the width: a finger needs a bigger target on a phone AND
     on a touch laptop, and a narrow dock panel on a desktop has a mouse in
     front of it. (docs/client.md: width is the panel's, the pointer is the
     device's.) */
  const coarse = useCoarsePointer()
  const rebindable = shortcut.rebindable === true
  const custom = isCustomized(shortcut.id)
  const reserved = chords.map((chord) => reservedChord(chord)).find(Boolean)
  const warnings = rebindable
    ? chords.flatMap((chord) => chordWarnings(chord, shortcut.id, DESKTOP))
    : []

  const subtitle = (
    <span className="block space-y-1">
      {shortcut.note && <span className="block text-pretty">{shortcut.note}</span>}
      {warnings.map((warning) => (
        <WarningLine key={warning.kind + warning.text} warning={warning} />
      ))}
    </span>
  )

  /* Two lines on mobile — title with its warnings, then the chord on the left
     and its controls on the right — because a right-aligned cluster of keycaps,
     a switch and two buttons fighting the title for 300px reads as noise. From
     sm up there is room for the one-line row again. */
  return (
    <div className="flex min-h-11 flex-col gap-2.5 py-3 @panel-sm:flex-row @panel-sm:items-center @panel-sm:justify-between @panel-sm:gap-x-4">
      <div className="min-w-0 @panel-sm:flex-1">
        <div className="truncate text-sm font-medium">{shortcut.label}</div>
        {subtitle && (
          <div className="mt-0.5 text-xs break-words text-muted-foreground">{subtitle}</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 @max-panel-sm:justify-between @panel-sm:shrink-0 @panel-sm:justify-end @panel-sm:gap-1.5">
        {/* Alternatives read as alternatives, the way the help sheet prints them. */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {shortcut.display ? (
            <Shortcut keys={shortcut.display} />
          ) : chords.length === 0 ? (
            <span className="text-xs text-muted-foreground">Not bound</span>
          ) : (
            chords.map((chord, index) => (
              <React.Fragment key={chord}>
                {index > 0 && <span className="text-[11px] text-muted-foreground">or</span>}
                <Shortcut chord={chord} />
              </React.Fragment>
            ))
          )}
        </div>
        {rebindable ? (
          <>
            {/* Only offered where something else wants the key: elsewhere there is
                nothing to override and a switch would be a question with one
                answer. A hard-reserved chord is not overridable at all — the page
                never receives it — so the switch says so by being disabled. */}
            {reserved && (
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground @max-panel-sm:text-xs">
                <span>Override</span>
                <Switch
                  checked={override && reserved.reserved !== "hard"}
                  disabled={reserved.reserved === "hard"}
                  onCheckedChange={(value) => setShortcutOverride(shortcut.id, value)}
                />
              </label>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(coarse && "h-9", "@max-panel-sm:flex-1")}
              onClick={onRecord}
            >
              Change
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className={cn(coarse && "size-9")}
              aria-label="Reset to the default"
              title="Reset to the default"
              disabled={!custom}
              onClick={() => resetShortcut(shortcut.id)}
            >
              <RotateCcwIcon />
            </Button>
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground @max-panel-sm:text-xs">Fixed</span>
        )}
      </div>
    </div>
  )
}

/** The desktop shell's one system-wide key: bring the app forward on a new
    thread from anywhere (lib/desktop.ts). An Electron accelerator, not one of
    the app's chords — the OS holds it — so it is typed, not recorded. */
function QuickEntryGroup() {
  const quick = useQuickEntry()
  const [value, setValue] = React.useState(quick.accelerator)
  const [saving, setSaving] = React.useState(false)
  const save = async (next: string) => {
    setSaving(true)
    await quick.set(next)
    setSaving(false)
  }
  return (
    <Group label="Desktop">
      <Row
        icon={KeyboardIcon}
        title="Quick entry"
        subtitle={`Starts a new thread from any application. An Electron accelerator such as ${QUICK_ENTRY_DEFAULT} or CommandOrControl+Shift+Space; empty turns it off.`}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save(value)
          }}
        >
          <Input
            aria-label="Quick entry shortcut"
            className="w-48 font-mono text-xs"
            value={value}
            placeholder="Off"
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={saving || value.trim() === quick.accelerator}>
            Save
          </Button>
        </form>
      </Row>
      {quick.error && (
        <div className="pb-3">
          <Notice tone="error" action={<CopyButton text={quick.error} />}>
            {quick.error}
          </Notice>
        </div>
      )}
    </Group>
  )
}

export function KeyboardPage() {
  const meta = sectionMeta("keyboard")
  const bindings = useKeybindings()
  const confirm = useConfirm()
  const [recording, setRecording] = React.useState<ShortcutId | null>(null)
  const target = SHORTCUTS.find((entry) => entry.id === recording) ?? null

  const anyCustom = SHORTCUTS.some((entry) => isCustomized(entry.id))

  const resetAll = async () => {
    const ok = await confirm({
      title: "Reset every shortcut?",
      description: "Every chord goes back to what this release ships with, on this device.",
      confirmLabel: "Reset",
    })
    if (ok) resetAllShortcuts()
  }

  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <Button type="button" variant="outline" disabled={!anyCustom} onClick={() => void resetAll()}>
            <RotateCcwIcon />
            Reset all
          </Button>
        }
      />
      {SHORTCUT_SCOPES.map((scope) => {
        const rows = SHORTCUTS.filter((entry) => entry.scope === scope)
        if (rows.length === 0) return null
        return (
          <Group key={scope} label={scope}>
            {rows.map((entry) => (
              <ShortcutRow
                key={entry.id}
                shortcut={entry}
                chords={bindings[entry.id].chords}
                override={bindings[entry.id].override}
                onRecord={() => setRecording(entry.id)}
              />
            ))}
          </Group>
        )
      })}
      {window.desktop?.setQuickEntry && <QuickEntryGroup />}
      <Group label="About these keys">
        <div className="flex items-start gap-3 py-3 text-xs text-muted-foreground">
          <KeyboardIcon className="mt-0.5 size-4 shrink-0" />
          <p className="text-pretty">
            Shortcuts are stored on this device and never synced.{" "}
            {DESKTOP
              ? "In the desktop app the page receives every chord the operating system does not take first, so a binding here wins over the browser defaults it names."
              : `In a browser tab a few chords never reach the page at all — ${formatChord(
                  "mod+n"
                )}, ${formatChord("mod+t")}, ${formatChord(
                  "mod+w"
                )} and the like are the browser's own and can only be taken back by the installed desktop app. The rest are yours as long as "Override" is on.`}
          </p>
        </div>
      </Group>
      <RecordDialog
        shortcut={target}
        open={recording !== null}
        onOpenChange={(open) => !open && setRecording(null)}
      />
    </>
  )
}
