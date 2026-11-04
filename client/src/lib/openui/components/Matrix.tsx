/* ── Matrix ──
   A grid whose cells are answers — yes, no, partly, not applicable — with a
   few words of qualification. It is what "does each runtime save X?" turns out to
   be when it is written as a `Table`: a column of the word "Yes" the eye has
   to read one cell at a time. Here the verdict leads each cell as a glyph, and
   the words after it are the qualification.

   The cell stays a plain string, as `Table`'s does (a model that must declare a
   typed cell per column gets the pairing wrong far more than it gets a string
   wrong): a cell that opens with `yes`, `no`, `partial` or `n/a` is drawn as
   that state with the rest as its note, and any other cell is drawn as text.
   The word is kept for a screen reader, so the glyph is never the only carrier,
   and the four verdicts are read by `kit`'s `readStateCell` — the one reader a
   `Table` and a `Matrix` share, so `yes, per request` cannot mean two things in
   one answer.

   A `Matrix` draws only the four verdicts and leaves everything else as text:
   it is a grid of *answers*, so a cell that says "412 tests" is a note rather
   than a status. A `Table` with `tones: true` chips the wider word list. */
import { z } from "zod/v4"
import { Check, Minus, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { BODY, Box, BoxHeader, LABEL, PAD, readStateCell } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

type State = "yes" | "no" | "partial" | "na"

const STATE = {
  yes: { Icon: Check, tone: "text-success", word: "Yes" },
  no: { Icon: X, tone: "text-destructive", word: "No" },
  partial: { Icon: Minus, tone: "text-warning", word: "Partly" },
  na: { Icon: null, tone: "text-muted-foreground", word: "Not applicable" },
} as const

/** A cell read as one of the four verdicts; anything else is only a note. */
function readVerdict(raw: string | undefined): { state?: State; note: string } {
  const { state, note } = readStateCell(raw)
  if (!state) return { note }
  const verdict: State | undefined = state === "yes" ? "yes" : state === "no" ? "no" : state === "n/a" || state === "na" ? "na" : /^(partial|partly)$/.test(state) ? "partial" : undefined
  return verdict ? { state: verdict, note } : { note: (raw ?? "").trim() }
}

function Cell({ raw }: { raw: string | undefined }) {
  const { state, note } = readVerdict(raw)
  if (!state) {
    return note ? <RichText text={note} /> : <span aria-hidden className="text-muted-foreground">&ndash;</span>
  }
  const { Icon, tone, word } = STATE[state]
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5">
      {Icon ? (
        <Icon aria-hidden className={cn("mt-[0.28em] size-3.5 shrink-0", tone)} strokeWidth={2.5} />
      ) : (
        <span aria-hidden className={cn("w-3.5 shrink-0 text-center text-[0.6875rem]", tone)}>
          n/a
        </span>
      )}
      <span className="sr-only">{word}</span>
      {note && (
        <span className={cn("min-w-0", state === "na" && "text-muted-foreground")}>
          <RichText text={note} />
        </span>
      )}
    </span>
  )
}

export const Matrix = defineComponent({
  name: "Matrix",
  description:
    "A grid of verdicts: the first column names each row, and every other cell opens with yes, no, partial or n/a, then a few words of qualification.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const columns = props.columns ?? []
    const rows = (props.rows ?? []).filter((row) => Array.isArray(row) && row.length > 0)
    if (columns.length === 0) return null
    // Two columns (a name and its answer) fit any width; more become a block per row below `@panel-sm`.
    const stacked = columns.length > 2
    return (
      <Box>
        {props.title && <BoxHeader title={props.title} />}
        {stacked && (
          <ul className="w-full min-w-0 list-none divide-y divide-rule @panel-sm:hidden">
            {rows.map((row, rowIndex) => (
              <li key={rowIndex} className={cn("min-w-0 space-y-1", PAD)}>
                <p className={cn(BODY, "font-medium")}>
                  <RichText text={(row[0] ?? "").trim() || "–"} />
                </p>
                <dl className="min-w-0 space-y-1">
                  {columns.slice(1).map((column, index) => (
                    <div key={index} className="flex min-w-0 flex-col gap-0.5">
                      <dt className={cn(LABEL, "min-w-0")}>{column}</dt>
                      <dd className={cn(BODY, "min-w-0")}>
                        <Cell raw={row[index + 1]} />
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
        <div className={cn("w-full min-w-0", stacked && "hidden @panel-sm:block")}>
          <UiTable>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column, index) => (
                  <TableHead key={index} className={cn(LABEL, "h-8 px-2.5 whitespace-normal @panel-sm:px-3")}>
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={rowIndex}>
                  {columns.map((_, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      className={cn(BODY, "min-w-24 px-2.5 align-top break-words whitespace-normal @panel-sm:px-3", cellIndex === 0 && "font-medium")}
                    >
                      {cellIndex === 0 ? <RichText text={row[0] ?? ""} /> : <Cell raw={row[cellIndex]} />}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </UiTable>
        </div>
      </Box>
    )
  },
})
