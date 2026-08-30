/* ── Terminal helper keyboard ──
   The row of on-screen keys a soft keyboard cannot reach — Tab, Ctrl, the
   arrows, the control chords — shown only on mobile, where the terminal is used
   on a device that has no physical keyboard. Sits just above the terminal
   canvas; a key's byte sequence is computed by lib/workspace/terminal-keymap
   and handed to xterm's `input()`, which routes it through `onData` exactly like
   a real keypress.

   Modifiers are sticky: tapping Ctrl, Alt or Shift latches it, so the next key
   press is the chord (Ctrl+C on one tap). Tapping the same modifier again (or
   tapping a key) releases it. Custom keys added by the user (see
   terminal-keys.ts) join the row after the built-ins.

   This is deliberately a single compact, horizontally scrollable row — a phone
   screen is narrow, and a keyboard that wraps to three rows is a keyboard that
   hides the terminal. The whole row is `shrink-0` in the panel's column, so the
   terminal canvas keeps its height. */
import * as React from "react"
import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  BUILTIN_KEYS,
  NO_MODS,
  parseCustomSequence,
  resolveKey,
  toDef,
  type TerminalKeyDef,
  type TerminalModifiers,
} from "@/lib/workspace/terminal-keymap"
import { addTerminalKey, removeTerminalKey, useTerminalKeys } from "@/lib/workspace/terminal-keys"

const MODIFIER_IDS = new Set(["ctrl", "alt", "shift"])

function KeyCap({
  label,
  className,
  active,
  ...props
}: { label: React.ReactNode; active?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={active || undefined}
      className={cn(
        "h-8 min-w-8 shrink-0 gap-1 rounded-md px-2 text-xs font-medium tabular-nums",
        active && "bg-muted text-foreground",
        className
      )}
      {...props}
    >
      {label}
    </Button>
  )
}

/** One row of helper keys, reading the sticky modifier state and the custom
    keys, and calling `onKey` with the resolved bytes for each press. */
export function TerminalKeyRow({ onKey, disabled }: { onKey: (data: string) => void; disabled?: boolean }) {
  const isMobile = useIsMobile()
  const customKeys = useTerminalKeys()
  const [mods, setMods] = React.useState<TerminalModifiers>(NO_MODS)

  /* Modifiers latch for the next press; any non-modifier key clears them once it
     has consumed them — the latched state is "the next key", never a mode you
     have to remember to switch off. All hooks run unconditionally so the early
     mobile return below cannot reorder them across renders. */
  const press = React.useCallback(
    (def: TerminalKeyDef) => {
      const data = resolveKey(def, mods)
      if (!MODIFIER_IDS.has(def.id)) setMods(NO_MODS)
      onKey(data)
    },
    [mods, onKey]
  )

  const toggleMod = React.useCallback((key: "ctrl" | "alt" | "shift") => {
    setMods((current) => ({ ...current, [key]: !current[key] }))
  }, [])

  if (!isMobile) return null

  const allDefs: TerminalKeyDef[] = [...BUILTIN_KEYS, ...customKeys.map(toDef)]

  return (
    <div
      data-slot="terminal-keys"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/60 px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {allDefs.map((def) => {
        const isModifier = MODIFIER_IDS.has(def.id)
        const active = isModifier ? mods[def.id as "ctrl" | "alt" | "shift"] : false
        /* title: the "what does this do" a user hovers for. A latched modifier
           is the one that needs explaining — tap it, then tap a key. The other
           keys just send the bytes (or the label itself, for a bare arrow). */
        const title = isModifier
          ? `${def.label}: tap, then tap a key to send ${def.label}+key`
          : `Send ${def.label}`
        return (
          <KeyCap
            key={def.id}
            label={def.label}
            active={active}
            title={title}
            onPointerDown={(event: React.PointerEvent) => {
              // Keep the terminal canvas from taking the tap and blurring.
              event.preventDefault()
            }}
            onClick={() => {
              if (disabled) return
              if (isModifier) toggleMod(def.id as "ctrl" | "alt" | "shift")
              else press(def)
            }}
            className={cn(!isModifier && def.kind === "seq" && "font-mono")}
          />
        )
      })}
      <CustomKeyButton disabled={disabled} />
    </div>
  )
}

function CustomKeyButton({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("")
  const [send, setSend] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const customKeys = useTerminalKeys()

  const add = () => {
    const bytes = parseCustomSequence(send || label)
    if (!bytes) {
      setError("Enter a key name (e.g. tab, ctrl+c, \\x1b[3~) or a \\x sequence.")
      return
    }
    // A label-only entry sends the parsed bytes of whatever name was given.
    addTerminalKey({ label: label.trim() || bytes, send: bytes })
    setLabel("")
    setSend("")
    setError(null)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Manage custom keys"
            title="Custom keys"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Plus className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <PopoverHeader>
          <PopoverTitle className="text-sm">Custom terminal keys</PopoverTitle>
          <PopoverDescription className="text-xs">
            Add a key your soft keyboard can't produce. Use a name ("tab", "ctrl+c",
            "f5") or a raw "\x1b…" sequence.
          </PopoverDescription>
        </PopoverHeader>
        <div className="space-y-2">
          {customKeys.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {customKeys.map((key) => (
                <span
                  key={key.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-xs"
                >
                  {key.label}
                  <button
                    type="button"
                    aria-label={`Remove ${key.label}`}
                    className="rounded text-muted-foreground hover:text-destructive"
                    onClick={() => removeTerminalKey(key.id)}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label, e.g. Ctrl+S"
              className="h-8 w-full rounded-md border border-input bg-input/30 px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
            <input
              value={send}
              onChange={(event) => setSend(event.target.value)}
              placeholder="Send, e.g. ctrl+s or \\x13"
              className="h-8 w-full rounded-md border border-input bg-input/30 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
            {error && <p className="text-[11px] text-destructive">{error}</p>}
            <Button size="sm" className="w-full" onClick={add} disabled={disabled || (!label.trim() && !send.trim())}>
              Add key
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Named keys: esc, tab, enter, up/down/left/right, home, end, backspace,
            delete, pageup, pagedown, f1–f12. Anything else as a "\x" sequence.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
