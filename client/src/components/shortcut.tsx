/* ── One way to print a keyboard shortcut ──
   Every surface that shows a chord — the sheet, the palette, a menu row, a
   tooltip, the sidebar's hover hint, a permission card's digits — draws it with
   this, on top of shadcn's `Kbd`/`KbdGroup`. Before, half of them printed
   `formatChord()` into bare text and the other half built their own keycaps, so
   the same chord read three ways depending on where you met it.

   Two ways in, because not every printable key is a bound chord: `chord` is the
   vocabulary of `lib/shortcuts` ("mod+k"), split into caps by `chordKeys`;
   `keys` is literal caps for a range or a single glyph the table prints as
   `display` ("1…9", "↵"). */
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { chordKeys } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"

export function Shortcut({
  chord,
  keys,
  className,
  keyClassName,
}: {
  /** A chord in `lib/shortcuts`' vocabulary — "mod+shift+enter". */
  chord?: string
  /** Literal caps, for a range or a glyph that is not a binding. */
  keys?: string[]
  className?: string
  keyClassName?: string
}) {
  const caps = keys ?? (chord ? chordKeys(chord) : [])
  if (caps.length === 0) return null
  return (
    <KbdGroup className={cn("shrink-0", className)}>
      {caps.map((cap, index) => (
        <Kbd key={`${cap}:${index}`} className={keyClassName}>
          {cap}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
