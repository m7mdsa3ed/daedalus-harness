/**
 * A table. Plain string margins rather than a row-of-cells schema: a model that
 * has to declare a column set *and* keep its rows in that order gets the pairing
 * wrong far more often than it gets one array of strings wrong.
 *
 * Two shapes, one data, and three columns is the line between them: past
 * `@panel-sm` it is always the grid, and below it a row of three or more is a
 * block — the first column is the block's name and every other column is a named
 * fact under it. A five-column table squeezed into a phone panel was a sideways
 * scroller that showed two columns and hid the rest; a list shows all of them at
 * the width it has. Two columns fit at any width, so they stay a table. Only one
 * shape is ever drawn (`display:none`, never merely off-screen), so a screen
 * reader hears the data once.
 *
 * `tone`: `muted` greys the cells; otherwise the first column is the row's name
 * and wears it.
 *
 * `tones: true` draws a cell that opens with a state word as a chip with the
 * rest of the cell after it — opt-in, because a table of ordinary prose is the
 * common case and a rule nobody asked for would reformat it (`kit`'s
 * `readStateCell` says why).
 */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { BODY, Box, CELL_STATES, LABEL, PAD_ROW, readStateCell, TITLE, ToneChip } from "@/lib/openui/kit"
import { plainText, RichText } from "@/lib/openui/rich-text"

/** One cell: its state as the app's chip when it opens with one, the rest as
    written. `tones` is the table's opt-in, so an ordinary cell is one string
    through `RichText` and nothing else. */
function ToneCell({ raw, tones }: { raw: string | undefined; tones?: boolean }) {
  const { state, note } = readStateCell(raw)
  const chip = tones && state ? CELL_STATES[state] : undefined
  if (!chip) return <RichText text={note} />
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 align-top">
      <ToneChip text={chip.word} tone={chip.tone} />
      {note && (
        <span className="min-w-0">
          <RichText text={note} />
        </span>
      )}
    </span>
  )
}

/** A cell is a number when it reads as one — a figure, a currency, a percent,
    a short unit. A column whose every filled cell is one aligns to the end. */
const NUMERIC = /^[-+~]?[$€£¥]?\s?\d[\d,.]*\s?(%|[a-zA-Z]{1,3})?$/
function numericColumns(columns: string[], rows: string[][]) {
  return columns.map((_, c) => {
    const cells = rows.map((row) => row[c]?.trim() ?? "").filter(Boolean)
    // Read through the marks: `**22**` is a figure in bold, not a string.
    return cells.length > 0 && cells.every((cell) => NUMERIC.test(plainText(cell)))
  })
}

/** Each column's share of the width, from what it holds. Left to the browser's
    auto layout, a short name column beside two prose columns was squeezed until
    "Two rounds" broke across two lines; weighting by the average cell length
    gives prose the room it needs and a name column at least its longest name
    (up to a cap, past which it may wrap like anything else). */
function columnWidths(columns: string[], rows: string[][]) {
  const weights = columns.map((column, c) => {
    const lengths = rows.map((row) => plainText((row[c] ?? "").trim()).length).filter((n) => n > 0)
    const average = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
    const longest = lengths.length ? Math.max(...lengths) : 0
    const floor = c === 0 ? Math.min(longest, 18) : Math.min(longest, 8)
    return Math.min(60, Math.max(average, floor, plainText(column).length, 6))
  })
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((weight) => `${((weight / total) * 100).toFixed(2)}%`)
}

export const Table = defineComponent({
  name: "Table",
  description: "A grid of text cells. `columns` names the headings and each entry of `rows` is one row. `tones: true` draws a cell that opens with a state word (yes, no, partial, n/a, pass, fail, warn, blocked, done, running, skip, pending) as a coloured chip with the rest of the cell after it.",
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    header: z.boolean().optional(),
    tone: z.enum(["default", "muted", "accent"]).optional(),
    tones: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const numeric = numericColumns(props.columns, props.rows)
    const muted = props.tone === "muted"
    /* A cell that carries a state is a chip, so its column is not a column of
       end-aligned figures — the tone reading wins over the numeric one. */
    const toned = (row: string[], index: number) => props.tones && Boolean(readStateCell(row[index]).state)
    // Two columns (a name and its value) still fit a phone panel, and stacking
    // them would put a column label above every row for nothing.
    const stacked = props.columns.length > 2
    const widths = columnWidths(props.columns, props.rows)
    return (
      <Box>
        {/* Narrow: one block per row. The name is the block's head, and a column
            with nothing in that row is left out rather than drawn as a label
            with a blank beside it. */}
        {stacked && (
          <ul className="w-full min-w-0 list-none divide-y divide-border/70 @panel-sm:hidden">
            {props.rows.map((row, rowIndex) => {
              const facts = props.columns
                .map((column, index) => ({ column, value: (row[index] ?? "").trim(), index }))
                .slice(1)
                .filter((fact) => fact.value !== "")
              return (
                <li key={rowIndex} className={cn("min-w-0 space-y-1.5", PAD_ROW)}>
                  <p className={cn(TITLE, "text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)]", muted && "text-muted-foreground")}>
                    {(row[0] ?? "").trim() ? <ToneCell raw={row[0]} tones={props.tones} /> : "–"}
                  </p>
                  {facts.length > 0 && (
                    <dl className="min-w-0 space-y-0.5">
                      {facts.map((fact) => (
                        <div key={fact.index} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                          <dt className={cn(LABEL, "min-w-0")}>{fact.column}</dt>
                          <dd
                            className={cn(
                              BODY,
                              "ms-auto min-w-0 text-end",
                              muted && "text-muted-foreground",
                              numeric[fact.index] && !toned(row, fact.index) && "tabular-nums"
                            )}
                          >
                            <ToneCell raw={fact.value} tones={props.tones} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {/* Wide: the registry table, whose own container scrolls, so a table
            still wider than the panel scrolls inside the turn rather than widening it. */}
        <div className={cn("w-full min-w-0", stacked && "hidden @panel-sm:block")}>
          <UiTable>
            {props.header !== false && (
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  {props.columns.map((column, index) => (
                    <TableHead
                      key={index}
                      className={cn(LABEL, "h-9 px-3.5 whitespace-normal @panel-sm:px-4", numeric[index] ? "text-end" : "text-start")}
                    >
                      {column}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {props.rows.map((row, rowIndex) => (
                <TableRow key={rowIndex} className="hover:bg-muted/30">
                  {props.columns.map((_, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      className={cn(
                        BODY,
                        "min-w-24 px-3.5 py-2.5 align-top break-words whitespace-normal @panel-sm:px-4",
                        numeric[cellIndex] && !toned(row, cellIndex) && "min-w-0 text-end whitespace-nowrap tabular-nums",
                        muted && "text-muted-foreground",
                        cellIndex === 0 && !muted && "font-semibold"
                      )}
                    >
                      <ToneCell raw={row[cellIndex]} tones={props.tones} />
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
