/**
 * A table the reader can correct. The idea is react-ui's `EditableTable`; the
 * shape is ours, for the same reason `Table` takes plain string margins: a
 * model that writes `columns` and `rows` as strings gets the pairing right far
 * more often than one declaring typed column records and positional values.
 *
 * So nothing is declared that can be read: a column whose every cell is a
 * figure edits as one (`numericColumns`, shared with `Table`), a column of
 * `YYYY-MM-DD` cells is a date field, and `options` is the one thing a model
 * must say — `{Status: ["open", "closed"]}` makes that column a select. The
 * first column is the row's name and stays as written: it is what each change
 * is reported against, and a row renamed mid-edit would report against a name
 * the model never wrote.
 *
 * What it says back is the diff, never the table: "Send changes" fills the
 * composer with one line per changed cell, old → new. It does not go through
 * form state on purpose — a field outside a form hands the action the whole
 * store, so every `$variable` in the view would ride along, and a table's
 * value is rows the composer would print as JSON. The words are the same door
 * a Button's are (`useOpenuiActions().fill`), unsent.
 *
 * Narrow panels get `Table`'s own bargain: one block per row, the name as its
 * head and each column a labelled field under it; only one shape is ever
 * drawn, so a screen reader meets each field once.
 */
import { z } from "zod/v4"
import { useMemo, useState } from "react"
import { defineComponent, useIsStreaming } from "@openuidev/react-lang"
import { Button as UiButton } from "@/components/ui/button"
import { Input as UiInput } from "@/components/ui/input"
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useOpenuiActions } from "@/lib/openui/actions"
import { BODY, Box, LABEL, META, PAD_ROW, RecordList, TITLE } from "@/lib/openui/kit"
import { numericColumns } from "@/lib/openui/components/Table"
import { plainText } from "@/lib/openui/rich-text"
import { cn } from "@/lib/utils"

type Kind = { type: "text" | "number" | "date" } | { type: "select"; options: string[] }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function columnKinds(columns: string[], rows: string[][], options: Record<string, string[]> | undefined): Kind[] {
  const numeric = numericColumns(columns, rows)
  return columns.map((column, c) => {
    const listed = options?.[column]
    if (listed?.length) return { type: "select", options: listed }
    const cells = rows.map((row) => row[c]?.trim() ?? "").filter(Boolean)
    if (cells.length > 0 && cells.every((cell) => ISO_DAY.test(cell))) return { type: "date" }
    return { type: numeric[c] ? "number" : "text" }
  })
}

/* Borderless until pointed at or focused: a grid of boxed inputs reads as a
   form to fill in, where this is a table to correct. An edited cell keeps a
   tint so the reader can see what the message will say. */
const CELL = "h-8 rounded-inner border-transparent bg-transparent px-2 shadow-none hover:border-input pointer-coarse:h-11"
const EDITED = "border-warning/40 bg-warning/10 hover:border-warning/60"

function CellField({
  kind,
  value,
  original,
  label,
  disabled,
  numeric,
  onChange,
}: {
  kind: Kind
  value: string
  original: string
  label: string
  disabled: boolean
  numeric: boolean
  onChange: (next: string) => void
}) {
  const edited = value !== original
  const said = edited ? `edited, was ${original || "empty"}` : undefined
  if (kind.type === "select") {
    // A value the model wrote outside its own options is still a value.
    const items = kind.options.includes(original) || !original ? kind.options : [original, ...kind.options]
    return (
      <UiSelect value={value || null} onValueChange={(next) => onChange(next == null ? "" : String(next))} disabled={disabled}>
        <SelectTrigger size="sm" aria-label={label} aria-description={said} className={cn(CELL, "w-full min-w-0", edited && EDITED)}>
          {/* Explicit children: Base UI's `SelectValue` renders none of its own. */}
          <SelectValue>{value || "–"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </UiSelect>
    )
  }
  return (
    <UiInput
      type={kind.type === "date" ? "date" : "text"}
      /* Not `type="number"`: it refuses "$1,200" and "12%", which are figures
         `numericColumns` counts as numbers. The keypad is all a phone needs. */
      inputMode={kind.type === "number" ? "decimal" : undefined}
      aria-label={label}
      aria-description={said}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(CELL, BODY, numeric && "text-end tabular-nums", edited && EDITED)}
    />
  )
}

export const EditableTable = defineComponent({
  name: "EditableTable",
  description:
    "A table whose cells the reader can correct and send back as a list of changes. Same `columns` and `rows` as Table; `options` maps a column name to its choices, making it a select.",
  props: z.object({
    name: z.string(),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    options: z.record(z.string(), z.array(z.string())).optional(),
  }),
  component: ({ props }) => {
    const streaming = useIsStreaming()
    const actions = useOpenuiActions()
    /* Only what the reader changed, keyed `row:column`; the program's rows are
       the baseline, so a view still streaming in needs no copy to keep in sync. */
    const [edits, setEdits] = useState<Record<string, string>>({})
    const kinds = useMemo(() => columnKinds(props.columns, props.rows, props.options), [props.columns, props.rows, props.options])
    const numeric = useMemo(() => numericColumns(props.columns, props.rows), [props.columns, props.rows])

    const original = (r: number, c: number) => props.rows[r]?.[c] ?? ""
    const valueAt = (r: number, c: number) => edits[`${r}:${c}`] ?? original(r, c)
    const rowName = (r: number) => plainText(original(r, 0).trim()) || `Row ${r + 1}`
    const set = (r: number, c: number, next: string) =>
      setEdits((current) => {
        const key = `${r}:${c}`
        const { [key]: _dropped, ...rest } = current
        return next === original(r, c) ? rest : { ...rest, [key]: next }
      })

    const changes = Object.entries(edits).map(([key, next]) => {
      const [r, c] = key.split(":").map(Number)
      return { r, c, from: original(r, c), to: next }
    })
    changes.sort((a, b) => a.r - b.r || a.c - b.c)

    const send = () => {
      if (!actions || changes.length === 0) return
      const lines = changes.map(
        (change) => `- ${rowName(change.r)} · ${props.columns[change.c]}: ${change.from || "(empty)"} → ${change.to || "(empty)"}`
      )
      actions.fill([`Apply these edits to the ${props.name} table:`, ...lines].join("\n"))
    }

    const stacked = props.columns.length > 2
    const field = (r: number, c: number) => (
      <CellField
        kind={kinds[c]}
        value={valueAt(r, c)}
        original={original(r, c)}
        label={`${rowName(r)} ${props.columns[c]}`}
        disabled={streaming}
        numeric={numeric[c] && kinds[c].type === "number"}
        onChange={(next) => set(r, c, next)}
      />
    )

    return (
      <Box>
        {stacked && (
          <RecordList className="@panel-sm:hidden">
            {props.rows.map((_, r) => (
              <li key={r} className={cn("min-w-0 space-y-2", PAD_ROW)}>
                <p className={TITLE}>{rowName(r)}</p>
                <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-x-3 gap-y-1.5">
                  {props.columns.slice(1).map((column, offset) => (
                    <div key={offset} className="contents">
                      <span className={LABEL}>{column}</span>
                      {field(r, offset + 1)}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </RecordList>
        )}
        <div className={cn("w-full min-w-0", stacked && "hidden @panel-sm:block")}>
          <UiTable>
            <TableHeader>
              <TableRow className="border-rule hover:bg-transparent">
                {props.columns.map((column, c) => (
                  <TableHead
                    key={c}
                    className={cn(LABEL, "h-8 px-3 whitespace-normal @panel-sm:px-4", numeric[c] ? "text-end" : "text-start")}
                  >
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.rows.map((_, r) => (
                <TableRow key={r} className="border-rule hover:bg-wash">
                  <TableCell className={cn(BODY, "min-w-24 px-3 py-1.5 font-semibold break-words whitespace-normal @panel-sm:px-4")}>
                    {rowName(r)}
                  </TableCell>
                  {props.columns.slice(1).map((_, offset) => (
                    <TableCell key={offset} className="min-w-28 px-1.5 py-1 @panel-sm:px-2.5">
                      {field(r, offset + 1)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </UiTable>
        </div>
        <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-rule", PAD_ROW)}>
          <p className={META} aria-live="polite">
            {changes.length === 0 ? "Edit a cell to send a change" : `${changes.length} ${changes.length === 1 ? "cell" : "cells"} changed`}
          </p>
          <div className="flex items-center gap-1.5">
            <UiButton type="button" size="sm" variant="ghost" disabled={changes.length === 0} onClick={() => setEdits({})}>
              Reset
            </UiButton>
            <UiButton
              type="button"
              size="sm"
              disabled={streaming || changes.length === 0 || !actions}
              title={actions ? undefined : "There is no composer here to send the changes to"}
              onClick={send}
            >
              Send changes
            </UiButton>
          </div>
        </div>
      </Box>
    )
  },
})
