/* ── Matrix ──
   A grid whose cells are answers — yes, no, partly, not applicable — with a
   few words of qualification. It is what "does each runtime save X?" turns out
   to be when it is written as a `Table`: a column of the word "Yes" the eye has
   to read one cell at a time. Here the verdict leads each cell as a glyph, and
   the words after it are the qualification.

   The cell stays a plain string, as `Table`'s does (a model that must declare a
   typed cell per column gets the pairing wrong far more than it gets a string
   wrong): a cell that opens with `yes`, `no`, `partial` or `n/a` is drawn as
   that state with the rest as its note, and any other cell is drawn as text.
   The word is kept for a screen reader, so the glyph is never the only carrier. */
import { z } from "zod/v4"
import { Check, Minus, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { BODY, Box, BoxHeader, LABEL, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

type State = "yes" | "no" | "partial" | "na"

const STATE = {
  yes: { Icon: Check, tone: "text-success", word: "Yes" },
  no: { Icon: X, tone: "text-destructive", word: "No" },
  partial: { Icon: Minus, tone: "text-warning", word: "Partly" },
  na: { Icon: null, tone: "text-muted-foreground", word: "Not applicable" },
} as const

const LEAD = /^\s*(yes|no|partial|partly|n\/a|na)\b[\s:;,.\-]*/i

/** A cell read as `{state, note}`; a cell that opens with no verdict is `{note}`. */
export function readCell(raw: string | undefined): { state?: State; note: string } {
  const text = (raw ?? "").trim()
  const lead = LEAD.exec(text)
  if (!lead) return { note: text }
  const word = lead[1].toLowerCase()
  const state: State = word === "yes" ? "yes" : word === "no" ? "no" : word === "n/a" || word === "na" ? "na" : "partial"
  return { state, note: text.slice(lead[0].length).trim() }
}

function Cell({ raw }: { raw: string | undefined }) {
  const { state, note } = readCell(raw)
  if (!state) return note ? <RichText text={note} /> : <span aria-hidden className="text-muted-foreground">&mdash;</span>
  const { Icon, tone, word } = STATE[state]
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5">
      {Icon ? (
        <Icon aria-hidden className={cn("mt-[0.3em] size-3.5 shrink-0", tone)} strokeWidth={2.5} />
      ) : (
        <span aria-hidden className={cn("w-3.5 shrink-0 text-center text-xs", tone)}>
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
          <ul className="w-full min-w-0 list-none divide-y @panel-sm:hidden">
            {rows.map((row, rowIndex) => (
              <li key={rowIndex} className={cn("min-w-0 space-y-1.5", PAD_ROW)}>
                <p className="min-w-0 text-sm leading-snug font-medium break-words text-foreground">
                  <RichText text={(row[0] ?? "").trim() || "-"} />
                </p>
                <dl className="min-w-0 space-y-1">
                  {columns.slice(1).map((column, index) => (
                    <div key={index} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                      <dt className={cn(LABEL, "min-w-0")}>{column}</dt>
                      <dd className={cn(BODY, "ms-auto min-w-0 text-end")}>
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
                  <TableHead key={index} className="h-10 px-4 whitespace-normal text-muted-foreground">
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
                      className={cn("min-w-24 px-4 align-top break-words whitespace-normal", cellIndex === 0 && "font-medium")}
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
