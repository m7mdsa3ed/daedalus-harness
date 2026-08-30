/* ── Terminal helper keyboard ──
   The on-screen keys an Android/iOS soft keyboard cannot produce, and the
   escape sequences they have to send. Sanitized and quarantined here the way
   `lib/tools.ts` quarantines tool-call shapes: the panel knows how to *show* a
   key and how to hand its bytes to xterm, not how to encode a control
   character. This module owns that mapping.

   Two kinds of key, because they behave differently when a modifier is held:

   - **"text"** — a single printable character (a-z, A-Z, 0-9, space). This is
     the only kind a sticky Ctrl/Alt/Shift can meaningfully combine with: Ctrl+C
     is two keystrokes on paper but one byte on the wire, so a chord has to be
     computed here rather than sent verbatim.
   - **"csi"** — a sequence whose final byte is stateful, e.g. an arrow key.
     Modifiers are encoded as a parameter in the CSI string (`\x1b[1;5A` is
     Ctrl+Up). Detected by its shape, not claimed by a flag.
   - **"seq"** — an opaque sequence sent exactly as its bytes (Tab, Enter, Esc,
     a control char, or any custom key the user defined). A sticky modifier is
     intentionally *not* applied: the sequence is already the whole keypress.

   Numeric modifier bits are xterm's convention: shift=1, alt=2, ctrl=4, the CSI
   parameter is `1 + <sum>`, so Ctrl is `;5`, Ctrl+Shift is `;6`, and so on. */
import type { TerminalKey } from "./terminal-keys"

export type TerminalKeyKind = "text" | "csi" | "seq"

export interface TerminalKeyDef {
  id: string
  label: string
  kind: TerminalKeyKind
  /** "text" → the character. "csi" → the base sequence (e.g. "\x1b[A").
      "seq" → the bytes sent verbatim. */
  value: string
}

export type TerminalModifiers = { ctrl: boolean; alt: boolean; shift: boolean }

export const NO_MODS: TerminalModifiers = { ctrl: false, alt: false, shift: false }

const MOD_BIT = (m: TerminalModifiers): number =>
  1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0)

/** A "csi" key with modifiers applied → `\x1b[1;N<final>` or `\x1b[<n>;N~`. */
function withCsiMods(base: string, mods: TerminalModifiers): string {
  const bit = MOD_BIT(mods)
  // Matches both shapes: `\x1b[A` (single final byte) and `\x1b[5~` (numeric + `~`).
  const match = /^\x1b\[\d*([A-Za-z~])$/.exec(base)
  if (!match) return base
  const body = base.slice(2, -1) // "A", "", or "5"
  return `\x1b[${body && body !== "" ? `${body};${bit}` : `1;${bit}`}${match[1]}`
}

/** Ctrl applied to a single letter/digit/symbol → its control byte. */
function ctrlByte(char: string): string {
  const c = char.charCodeAt(0) & 0x1f
  return String.fromCharCode(c)
}

/** The bytes a pressed key actually sends, given the modifiers held. */
export function resolveKey(def: TerminalKeyDef, mods: TerminalModifiers): string {
  if (def.kind === "seq" || def.kind === "csi") {
    if (def.kind === "csi" && (mods.ctrl || mods.alt || mods.shift)) return withCsiMods(def.value, mods)
    return def.value
  }
  // "text": a printable key, combinable with the sticky modifiers.
  const char = def.value
  const upper = (mods.shift || mods.alt) && char.length === 1 && /[a-z]/.test(char) ? char.toUpperCase() : char
  if (mods.ctrl && mods.alt) return `\x1b${ctrlByte(upper)}`
  if (mods.ctrl) return ctrlByte(upper)
  if (mods.alt) return `\x1b${upper}`
  return upper
}

/** The built-in row, in display order. Every key is a terminal-essential that a
    soft keyboard cannot reach: Tab, the modifiers, the control chords, and the
    navigation cluster. Custom keys (see terminal-keys.ts) append after these.

    `label` is what the keycap shows. For a modifier it names itself; for a chord
    it names the combination; for a nav key it shows the symbol and the word, so
    a reader knows the ↑ is Up without guessing. */
export const BUILTIN_KEYS: TerminalKeyDef[] = [
  { id: "ctrl", label: "Ctrl", kind: "text", value: "c" },
  { id: "alt", label: "Alt", kind: "text", value: "m" },
  { id: "shift", label: "Shift", kind: "text", value: "a" },
  { id: "tab", label: "Tab", kind: "seq", value: "\t" },
  { id: "esc", label: "Esc", kind: "seq", value: "\x1b" },
  { id: "up", label: "↑ Up", kind: "csi", value: "\x1b[A" },
  { id: "down", label: "↓ Down", kind: "csi", value: "\x1b[B" },
  { id: "right", label: "→ Right", kind: "csi", value: "\x1b[C" },
  { id: "left", label: "← Left", kind: "csi", value: "\x1b[D" },
  { id: "home", label: "Home", kind: "csi", value: "\x1b[H" },
  { id: "end", label: "End", kind: "csi", value: "\x1b[F" },
  { id: "enter", label: "Enter", kind: "seq", value: "\r" },
  { id: "space", label: "Space", kind: "text", value: " " },
  { id: "ctrl-c", label: "Ctrl+C", kind: "seq", value: "\x03" },
  { id: "ctrl-d", label: "Ctrl+D", kind: "seq", value: "\x04" },
  { id: "ctrl-z", label: "Ctrl+Z", kind: "seq", value: "\x1a" },
]

/** A custom key (raw {label, send}) can always be sent verbatim; it is a "seq". */
export function toDef(key: TerminalKey): TerminalKeyDef {
  return { id: key.id, label: key.label, kind: "seq", value: key.send }
}

/* ── Custom key notation ──
   A soft keyboard cannot reach an arbitrary byte sequence, so a custom key is
   described in a small, human-typed notation and decoded here. The same normal
   forms a keycap would mean, plus raw `\xHH` hex escapes for anything else. */
const NAMED: Record<string, string> = {
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  enter: "\r",
  return: "\r",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  backspace: "\x7f",
  delete: "\x1b[3~",
  del: "\x1b[3~",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
}

/** Decode `\xHH` hex escapes; everything else passes through. */
function unescapeHex(text: string): string {
  return text.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

const BYTE_OF_NAMED = new Set(Object.keys(NAMED))

/** Split on the separators people actually type: "+", "-", ":", or a space. */
const SEPARATOR = /[+\-:,\s]+/

/** A user-written custom key's `send` string → the bytes to write. Invalid
    notation (an empty result, an unknown chord) returns null so the UI can say
    so rather than adding a key that silently does nothing.

    Accepted forms, in order:
      "ctrl+c" / "^c"        → the control byte (0x03)
      "alt+x"                → ESC + x
      "tab" / "f5" / "up"    → a named key from NAMED
      "\\x1b[3~"             → raw bytes; any non-"\x" runs pass through verbatim */
export function parseCustomSequence(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  const lower = text.toLowerCase()
  const parts = lower.split(SEPARATOR).filter(Boolean)

  // Ctrl+<letter> — a control char. Reject a bare letter: "c" is just the key "c",
  // not Ctrl+C, and treating it as one silently sends ^C whenever a user types it.
  if (parts.length === 2 && parts[0] === "ctrl" && /^[a-z]$/.test(parts[1]))
    return String.fromCharCode(parts[1].charCodeAt(0) & 0x1f)
  if (/^\^([a-z])$/.test(lower)) return String.fromCharCode(lower.charCodeAt(1) & 0x1f)

  // Alt+<letter> → ESC + letter.
  if (parts.length === 2 && parts[0] === "alt" && /^[a-z]$/.test(parts[1])) return `\x1b${parts[1]}`

  if (BYTE_OF_NAMED.has(lower)) return NAMED[lower]

  // A sequence of named keys separated by spaces, e.g. "esc c".
  if (parts.length > 1) {
    const bytes = parts.map((token) => (BYTE_OF_NAMED.has(token) ? NAMED[token] : null))
    if (bytes.every((b): b is string => b !== null)) return bytes.join("")
  }

  // Raw "\xHH" bytes (and any literal text mixed in) — the escape hatch.
  return unescapeHex(text)
}
