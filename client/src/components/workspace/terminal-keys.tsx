/* ── Terminal helper keyboard ──
   The row of on-screen keys a soft keyboard cannot reach — the modifiers, Tab,
   Esc, the arrows, the control chords — and the keys the reader defined
   themselves. A key's byte sequence is computed by `lib/workspace/terminal-keymap`
   and handed to xterm's `input()`, which routes it through `onData` exactly like
   a real keypress.

   Modifiers are sticky: tapping Ctrl, Alt or Shift latches it, so the next key
   press is the chord (Ctrl+C on one tap). Tapping the same modifier again, or
   pressing any other key, releases it.

   **Compact, and up to two rows.** The caps are small (28px, symbols where
   there is a conventional one — ↑, ⏎, ^C) and the block *wraps* rather than
   scrolling sideways: a single scrolling line meant half the keyboard was off
   the right-hand edge, and the half that was off it was the reader's own —
   which is a keyboard you have to swipe to type on. Two rows is the ceiling by
   default, because a keyboard taller than that is a keyboard that hides the
   terminal; anything past it scrolls, and the ⌃ button opens the block to its
   full height when there are more keys than that.

   Order is reach: the modifiers first (they are what the next tap combines
   with), then Tab and Esc, then the reader's own keys, then the rest of the
   built-ins. The two trailing actions — open the block, manage the keys — are
   outside the wrapping block so they cannot be pushed onto a line of their own.

   The row **follows the soft keyboard**. `interactive-widget=overlays-content`
   means the keyboard is drawn *over* the page rather than resizing it (see
   `lib/keyboard-inset.ts`), so a row anchored to the bottom of the panel sat
   underneath the keyboard — present, correct, and completely invisible on the
   one device it exists for. The panel pads itself by `--keyboard-inset`; this
   file only has to not fight it. */
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react"
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
import {
  addTerminalKey,
  moveTerminalKey,
  removeTerminalKey,
  updateTerminalKey,
  useTerminalKeys,
  type TerminalKey,
} from "@/lib/workspace/terminal-keys"
import { setTerminalPrefs, useTerminalPrefs } from "@/lib/workspace/terminal-prefs"

const MODIFIER_IDS = new Set(["ctrl", "alt", "shift"])
/** First in the row, in this order: what a tap is most likely to be. */
const LEADING_IDS = ["ctrl", "alt", "shift", "tab", "esc"]
/** Two rows of caps plus the gap between them, in the spacing scale: `h-7` +
    `gap-1` + `h-7` is fifteen units. A height rather than a clamp because the
    block is a flex wrap — a max-height is the only thing that holds it to two
    rows and still lets the rest scroll — and a *class* rather than a literal
    because this app scales `--spacing` with its density setting, which a rem in
    a style attribute would ignore. */
const TWO_ROWS = "max-h-15"

/** One cap. The label is the button's *content* — it was briefly a prop that
    nothing rendered, which is a row of blank keys: a keyboard you cannot read
    is not a keyboard. `name` is the accessible one, because half the caps are a
    symbol now ("↑", "⏎", "^C") and a symbol is not a name. */
function KeyCap({
  label,
  name,
  className,
  active,
  ...props
}: { label: string; name?: string; active?: boolean } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={active || undefined}
      aria-label={name ?? label}
      className={cn(
        /* One height and a floor on the width, so "Esc" and "↑" are the same
           cap and the block reads as a keyboard rather than as a sentence of
           buttons. 28px with a coarse pointer is under the 44px touch target
           the rest of the app keeps — deliberately: these are *keys*, pressed
           in sequence and in sight of the thing they are typing into, and a
           keyboard of 44px keys covers the terminal it exists to drive. A wide
           label still grows; a custom key may be a word. */
        "h-7 min-w-7 shrink-0 justify-center rounded-md px-1.5 text-[11px] leading-none font-medium tabular-nums",
        active && "bg-muted text-foreground ring-1 ring-ring/60",
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
export function TerminalKeyRow({
  onKey,
  disabled,
}: {
  onKey: (data: string) => void
  disabled?: boolean
}) {
  const customKeys = useTerminalKeys()
  const { keysExpanded } = useTerminalPrefs()
  const [mods, setMods] = React.useState<TerminalModifiers>(NO_MODS)

  /* Modifiers latch for the next press; any non-modifier key clears them once it
     has consumed them — the latched state is "the next key", never a mode you
     have to remember to switch off. */
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

  const leading = LEADING_IDS.map((id) => BUILTIN_KEYS.find((key) => key.id === id)).filter(
    (key): key is TerminalKeyDef => !!key
  )
  const rest = BUILTIN_KEYS.filter((key) => !LEADING_IDS.includes(key.id))
  const custom = customKeys.map(toDef)

  const cap = (def: TerminalKeyDef) => {
    const isModifier = MODIFIER_IDS.has(def.id)
    const active = isModifier ? mods[def.id as "ctrl" | "alt" | "shift"] : false
    /* title: the "what does this do" a user hovers for. A latched modifier is
       the one that needs explaining — tap it, then tap a key. The other keys
       just send the bytes (or the label itself, for a bare arrow). */
    const name = def.name ?? def.label
    const title = isModifier
      ? `${name}: tap, then tap a key to send ${name}+key`
      : `Send ${name}`
    return (
      <KeyCap
        key={def.id}
        label={def.label}
        name={name}
        active={active}
        title={title}
        disabled={disabled}
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
  }

  return (
    <div
      data-slot="terminal-keys"
      className="flex shrink-0 items-start gap-1 border-t border-border/60 px-2 py-1"
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-wrap content-start gap-1",
          /* Held to two rows, and scrolled past them, rather than allowed to
             grow: the terminal is what the rest of the panel is for. */
          !keysExpanded &&
            `${TWO_ROWS} overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`
        )}
      >
        {leading.map(cap)}
        {/* A divider only where there is something on both sides of it: with no
            custom keys a rule here would be a line drawn around nothing. */}
        {custom.length > 0 && (
          <span aria-hidden className="mx-0.5 h-7 w-px shrink-0 self-center bg-border/70" />
        )}
        {custom.map(cap)}
        {custom.length > 0 && (
          <span aria-hidden className="mx-0.5 h-7 w-px shrink-0 self-center bg-border/70" />
        )}
        {rest.map(cap)}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={keysExpanded ? "Collapse the key row" : "Show every key"}
          aria-pressed={keysExpanded}
          title={keysExpanded ? "One row" : "Show every key"}
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
          onPointerDown={(event: React.PointerEvent) => event.preventDefault()}
          onClick={() => setTerminalPrefs({ keysExpanded: !keysExpanded })}
        >
          {keysExpanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </Button>
        <CustomKeyButton />
      </div>
    </div>
  )
}

/* ── Managing the reader's own keys ──
   Add, rename, re-point and reorder. It grew from an add-only form: a key typed
   with the wrong sequence could only be deleted and retyped, and the row's
   order — which is the order a thumb reaches them in — could not be changed at
   all. Every row here edits in place, because a key being corrected is the same
   key (`updateTerminalKey` keeps the id). */
function CustomKeyButton() {
  const [open, setOpen] = React.useState(false)
  const customKeys = useTerminalKeys()

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
      <PopoverContent align="end" className="w-80 p-3">
        <PopoverHeader>
          <PopoverTitle className="text-sm">Custom terminal keys</PopoverTitle>
          <PopoverDescription className="text-xs">
            Add a key your soft keyboard can't produce. Use a name ("tab", "ctrl+c",
            "f5") or a raw "\x1b…" sequence.
          </PopoverDescription>
        </PopoverHeader>
        <div className="space-y-3">
          {customKeys.length > 0 && (
            <ul className="space-y-1">
              {customKeys.map((key, index) => (
                <CustomKeyRow
                  key={key.id}
                  entry={key}
                  first={index === 0}
                  last={index === customKeys.length - 1}
                />
              ))}
            </ul>
          )}
          <KeyForm onDone={() => setOpen(false)} />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Named keys: esc, tab, enter, up/down/left/right, home, end, backspace,
            delete, pageup, pagedown, f1–f12. Anything else as a "\x" sequence.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** One saved key: what it is called, where it sits, and the two ways to change
    it. The bytes are shown as the notation that produced them, escaped, because
    a raw `\x1b` in a list is an invisible character in a row that looks empty. */
function CustomKeyRow({
  entry,
  first,
  last,
}: {
  entry: TerminalKey
  first: boolean
  last: boolean
}) {
  const [editing, setEditing] = React.useState(false)

  if (editing)
    return (
      <li>
        <KeyForm entry={entry} onDone={() => setEditing(false)} />
      </li>
    )

  return (
    <li className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 py-1 pr-0.5 pl-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.label}</span>
      {/* What it sends, in the notation that would type it again — a raw
          `\x1b` here would be an invisible character in a row that then looks
          blank. */}
      <span className="min-w-0 max-w-20 shrink-0 truncate rounded border border-border/60 bg-background/60 px-1 font-mono text-[10px] text-muted-foreground">
        {printable(entry.send)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 text-muted-foreground hover:text-foreground"
        aria-label={`Move ${entry.label} left`}
        title="Move left"
        disabled={first}
        onClick={() => moveTerminalKey(entry.id, -1)}
      >
        <ChevronLeft className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 text-muted-foreground hover:text-foreground"
        aria-label={`Move ${entry.label} right`}
        title="Move right"
        disabled={last}
        onClick={() => moveTerminalKey(entry.id, 1)}
      >
        <ChevronRight className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${entry.label}`}
        title="Edit"
        onClick={() => setEditing(true)}
      >
        <Pencil className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${entry.label}`}
        title="Remove"
        onClick={() => removeTerminalKey(entry.id)}
      >
        <Trash2 className="size-3" />
      </Button>
    </li>
  )
}

/** The add form and the edit form are one form: the fields, the parse and the
    error message are identical, and the only difference is whether the result
    is written to an existing id. */
function KeyForm({ entry, onDone }: { entry?: TerminalKey; onDone: () => void }) {
  const [label, setLabel] = React.useState(entry?.label ?? "")
  const [send, setSend] = React.useState(entry ? printable(entry.send) : "")
  const [error, setError] = React.useState<string | null>(null)

  const submit = () => {
    const bytes = parseCustomSequence(send || label)
    if (!bytes) {
      setError("Enter a key name (e.g. tab, ctrl+c, \\x1b[3~) or a \\x sequence.")
      return
    }
    // A label-only entry sends the parsed bytes of whatever name was given.
    const next = { label: label.trim() || bytes, send: bytes }
    if (entry) updateTerminalKey(entry.id, next)
    else addTerminalKey(next)
    setLabel("")
    setSend("")
    setError(null)
    onDone()
  }

  return (
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
        placeholder="Send, e.g. ctrl+s or \x13"
        onKeyDown={(event) => {
          if (event.key === "Enter") submit()
        }}
        className="h-8 w-full rounded-md border border-input bg-input/30 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring"
      />
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1"
          onClick={submit}
          disabled={!label.trim() && !send.trim()}
        >
          {entry ? "Save" : "Add key"}
        </Button>
        {entry && (
          <Button size="sm" variant="ghost" aria-label="Cancel" title="Cancel" onClick={onDone}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Bytes as something a person can read back and retype: control characters and
    escapes as `\xHH`, everything else as itself. The inverse of the `\x`
    notation `parseCustomSequence` accepts, so what an edit form shows is what it
    would take to type the same key again. */
function printable(bytes: string): string {
  return [...bytes]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code < 0x20 || code === 0x7f
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : char
    })
    .join("")
}
