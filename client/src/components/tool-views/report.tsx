import * as React from "react"
import { CodeBlock, JsonView, LABEL, PANE, Prose, SmartBlock } from "@/components/tool-parts"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { isTable, parseReport, reportShape, type ReportTone } from "@/lib/tools/report"
import { cn } from "@/lib/utils"

/* Past this depth a report is drawn as the JSON tree — four levels of cards
   inside cards is a maze, not a reading. */
const MAX_DEPTH = 3
/* A list draws this many items before a button; a run of 240 verdicts is
   240 cards of prose. */
const LIST_LIMIT = 20

const TONE: Record<ReportTone, string> = {
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-warning/10 text-warning",
  good: "bg-success/10 text-success",
  neutral: "",
}

/* A nested object or a list entry: an outlined box, so one inside another
   still reads as nested on the pane's muted ground. */
const BOX = "rounded-lg border px-2.5 py-2"

/**
 * A subagent's report. JSON is drawn by role (`lib/tools/report`) with the
 * whole document one toggle away; prose and errors are `SmartBlock`'s.
 */
export function ReportBlock({ text, tone }: { text: string; tone?: "error" }) {
  const value = React.useMemo(() => (tone === "error" ? null : parseReport(text)), [text, tone])
  const [raw, setRaw] = React.useState(false)
  if (!value) return <SmartBlock text={text} tone={tone} />
  return (
    <div className="min-w-0 space-y-2">
      <button
        type="button"
        onClick={() => setRaw((open) => !open)}
        className="block text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {raw ? "Show formatted" : "Show raw JSON"}
      </button>
      {raw ? (
        <CodeBlock language="json">{JSON.stringify(value, null, 2)}</CodeBlock>
      ) : (
        <ReportGroup value={value} depth={0} />
      )}
    </div>
  )
}

function ReportGroup({ value, depth }: { value: unknown; depth: number }) {
  if (depth > MAX_DEPTH) return <JsonView value={value} text={JSON.stringify(value, null, 2)} preview={0} />
  if (Array.isArray(value)) return <ReportList items={value} depth={depth} />
  if (value && typeof value === "object") {
    const object = <ReportObject value={value as Record<string, unknown>} depth={depth} />
    return depth === 0 ? object : <div className={BOX}>{object}</div>
  }
  return <span className="text-sm">{String(value)}</span>
}

function ReportList({ items, depth }: { items: unknown[]; depth: number }) {
  const [all, setAll] = React.useState(false)
  if (items.length === 0) return <p className="text-xs text-muted-foreground">None</p>
  if (items.every((item) => item === null || typeof item !== "object")) {
    return (
      <ul className="space-y-0.5">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-2 text-sm leading-relaxed">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
            <span className="min-w-0 break-words">{String(item)}</span>
          </li>
        ))}
      </ul>
    )
  }
  if (isTable(items)) return <ReportTable rows={items} />
  const shown = all ? items : items.slice(0, LIST_LIMIT)
  return (
    <div className="space-y-1.5">
      <ol className="space-y-1.5">
        {shown.map((item, index) => (
          <li key={index} className={BOX}>
            {item && typeof item === "object" && !Array.isArray(item) ? (
              <ReportObject value={item as Record<string, unknown>} depth={depth + 1} item />
            ) : (
              <ReportGroup value={item} depth={depth + 1} />
            )}
          </li>
        ))}
      </ol>
      {shown.length < items.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Show {items.length - shown.length} more
        </button>
      )}
    </div>
  )
}

function ReportObject({ value, depth, item = false }: { value: Record<string, unknown>; depth: number; item?: boolean }) {
  const shape = reportShape(value, item)
  return (
    <div className="min-w-0 space-y-2">
      {(shape.title || shape.badges.length > 0) && (
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          {shape.title && (
            <span className="min-w-0 flex-1 basis-48 text-sm font-medium leading-relaxed text-foreground">
              {shape.title}
            </span>
          )}
          {shape.badges.map((badge) => (
            <Badge key={badge.key} title={badge.label} variant="secondary" className={TONE[badge.tone]}>
              {badge.text}
            </Badge>
          ))}
        </div>
      )}
      {shape.location && <p className="break-all font-mono text-xs text-muted-foreground">{shape.location}</p>}
      {shape.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
          {shape.facts.map((fact) => (
            <React.Fragment key={fact.key}>
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 break-words font-mono">{fact.value === null ? "None" : String(fact.value)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {shape.texts.map((field) => (
        <section key={field.key} className="min-w-0 space-y-0.5">
          <h5 className={LABEL}>{field.label}</h5>
          <div className="min-w-0">
            <Prose text={field.value as string} />
          </div>
        </section>
      ))}
      {shape.groups.map((field) => (
        <section key={field.key} className="min-w-0 space-y-1">
          <h5 className={LABEL}>
            {field.label}
            {Array.isArray(field.value) && ` · ${field.value.length}`}
          </h5>
          <ReportGroup value={field.value} depth={depth + 1} />
        </section>
      ))}
    </div>
  )
}

function ReportTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return (
    <div className={PANE}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} className="text-muted-foreground">{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {columns.map((column) => (
                <TableCell key={column} className="align-top break-words whitespace-normal">
                  {row[column] === undefined || row[column] === null ? "" : String(row[column])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
