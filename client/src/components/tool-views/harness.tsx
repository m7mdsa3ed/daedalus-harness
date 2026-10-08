/* ── The harness server's two meta-tools ── its own layout, so a call reads as
   "which operation ran" rather than as an MCP server · a JSON blob.

   `harness_run` is drawn as the operation's title, its fields and its result;
   `harness_help` — the same tool's discovery half — is drawn as the list of
   operations, or one operation's field-set. Both go through `extractHarnessCall`
   in `lib/tools/harness.ts`; nothing here matches a tool name. */
import * as React from "react"
import {
  BoxesIcon,
  ChevronRightIcon,
  ListIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { DetailSection, JsonView, LABEL, PANE, PANE_PAD, SmartBlock } from "@/components/tool-parts"
import {
  extractHarnessCall,
  harnessAction,
  harnessEffect,
  harnessFields,
  harnessOperationLabel,
  harnessPreview,
  harnessResult,
  harnessTable,
  type HarnessAction,
  type HarnessEffect,
  type HarnessTable,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"

const ACTION_ICONS: Record<HarnessAction, React.ComponentType<{ className?: string }>> = {
  list: ListIcon,
  get: SearchIcon,
  create: PlusIcon,
  update: PencilIcon,
  delete: Trash2Icon,
  run: PlayIcon,
}

/** The closed row's mark: what the call *did* (a plus, a pencil, a bin), so a
    run of harness calls scans by verb instead of as a column of identical
    boxes. A removal wears the red a failure does; everything else the
    harness's own fuchsia. */
export function harnessMark(item: ToolItem): {
  Icon: React.ComponentType<{ className?: string }>
  accent: string
  chip: string
} {
  const call = extractHarnessCall(item)
  const action = call?.verb === "run" ? harnessAction(call.operation) : null
  return {
    Icon: action ? ACTION_ICONS[action] : BoxesIcon,
    accent: action === "delete" ? "text-destructive" : "text-fuchsia-600 dark:text-fuchsia-400",
    chip: action === "delete" ? "bg-destructive/12" : "bg-fuchsia-500/12",
  }
}

/** What a list call returned, as a strip of names under the closed row — the
    answer is readable without opening the step. Nothing until a result lands,
    and nothing for a call that did not return a list of named rows. */
export function HarnessPreview({ item }: { item: ToolItem }) {
  const preview = harnessPreview(item)
  if (!preview) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {preview.labels.map((label, index) => (
        <span
          key={index}
          className="max-w-[11rem] truncate rounded-md bg-muted/60 px-1.5 py-px text-[11px] text-muted-foreground"
        >
          {label}
        </span>
      ))}
      {preview.more > 0 && <span className="text-[11px] text-muted-foreground/60">+{preview.more}</span>}
    </div>
  )
}

export function HarnessDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const call = extractHarnessCall(item)
  if (!call) return null
  const { value, text } = harnessResult(item)
  const error = call.error
  const hasArgs = Object.keys(call.args).length > 0
  const isJson = value !== null

  const subject =
    call.verb === "help"
      ? call.operation
        ? `fields for ${call.operation}`
        : call.search
          ? `“${call.search}”`
          : "the operations"
      : call.operation
        ? harnessOperationLabel(call.operation)
        : "an operation"

  const effect = call.verb === "run" ? harnessEffect(call.operation) : null

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <BoxesIcon className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="font-mono text-foreground">Harness</span>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
        <span className="text-muted-foreground">{subject}</span>
        {effect && (
          <span className={cn("rounded px-1 text-[10px] font-medium", EFFECT_STYLE[effect])}>{effect}</span>
        )}
        {call.verb === "run" && call.operation && (
          <span className="font-mono text-[10px] text-muted-foreground/60">{call.operation}</span>
        )}
      </div>
      {hasArgs && (
        <DetailSection label="Fields">
          <FieldList fields={harnessFields(call.args)} />
          <RawJson value={call.args} />
        </DetailSection>
      )}
      {error != null && (
        <DetailSection label="Error">
          <SmartBlock text={plain(error)} tone="error" />
        </DetailSection>
      )}
      {error == null && isJson && (
        <DetailSection
          label={`${active ? "Result so far" : "Result"}${Array.isArray(value) ? ` · ${value.length}` : ""}`}
        >
          <HarnessResult value={value} text={text} />
        </DetailSection>
      )}
      {error == null && !isJson && text.trim().length > 0 && (
        <DetailSection label={active ? "Result so far" : "Result"}>
          <SmartBlock text={text} />
        </DetailSection>
      )}
      {active && !isJson && !text.trim() && error == null && <ToolCallSkeleton className="py-1" />}
    </div>
  )
}

/** The harness tools answer in JSON, so the shape can be drawn: an operation's
    field-set, the operations list, or anything else as the JSON tree. */
function HarnessResult({ value, text }: { value: unknown; text: string }) {
  const record = asRecord(value)
  if (record && Array.isArray(record.operations)) return <OperationList operations={record.operations} />
  if (record && typeof record.name === "string" && typeof record.method === "string") return <OperationFields op={record} />
  if (Array.isArray(value)) {
    const table = harnessTable(value)
    if (table) return <ResultTable table={table} value={value} />
    if (value.length === 0) return <p className="text-xs text-muted-foreground">Nothing returned.</p>
  }
  if (record) {
    const fields = harnessFields(record)
    if (fields.length > 0) {
      return (
        <div className="space-y-1.5">
          <FieldList fields={fields} />
          <RawJson value={value} />
        </div>
      )
    }
  }
  return <JsonView value={value} text={text} preview={1} />
}

const EFFECT_STYLE: Record<HarnessEffect, string> = {
  read: "bg-muted text-muted-foreground",
  write: "bg-primary/10 text-primary",
  destroy: "bg-destructive/10 text-destructive",
}

/** A record as a key/value grid — keys in their own column so the eye reads
    down the values, the way the table reads down a column. */
function FieldList({ fields }: { fields: { key: string; value: string }[] }) {
  return (
    <dl className={cn(PANE_PAD, "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]")}>
      {fields.map((field) => (
        <React.Fragment key={field.key}>
          <dt className="font-mono text-muted-foreground/70">{field.key}</dt>
          <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** A list result as the few columns that name each row, capped, with the whole
    document one fold below for anyone who wants the rest. */
function ResultTable({ table, value }: { table: HarnessTable; value: unknown }) {
  const hidden = table.total - table.rows.length
  return (
    <div className="space-y-1.5">
      <div className={cn(PANE, "overflow-x-auto")}>
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="border-b border-border/50">
              {table.columns.map((column) => (
                <th key={column} className={cn(LABEL, "px-2 py-1 font-semibold")}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index} className="border-b border-border/30 last:border-0">
                {row.map((cell, column) => (
                  <td
                    key={column}
                    className={cn(
                      "max-w-[16rem] truncate px-2 py-1",
                      column === 0 ? "text-foreground" : "font-mono text-muted-foreground"
                    )}
                  >
                    {cell || <span className="text-muted-foreground/40">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && <p className="text-[11px] text-muted-foreground/70">+ {hidden} more</p>}
      <RawJson value={value} />
    </div>
  )
}

/** The unabridged JSON, folded: the view above chooses what to show, this is
    the way to check what it chose not to. */
function RawJson({ value }: { value: unknown }) {
  return (
    <details className="group text-[11px]">
      <summary className="w-fit cursor-pointer text-muted-foreground/70 select-none hover:text-foreground">
        Raw JSON
      </summary>
      <JsonView value={value} text={safeStringify(value)} preview={2} className="mt-1" />
    </details>
  )
}

function OperationList({ operations }: { operations: unknown[] }) {
  return (
    <ul className="space-y-1">
      {operations.map((entry, index) => {
        const op = asRecord(entry)
        if (!op) return null
        const name = typeof op.name === "string" ? op.name : ""
        const method = typeof op.method === "string" ? op.method : ""
        const description = typeof op.description === "string" ? op.description : ""
        const args = Array.isArray(op.args) ? op.args.filter((a): a is string => typeof a === "string") : []
        return (
          <li key={index} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[11px] text-foreground">{name}</span>
            {method && (
              <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{method}</span>
            )}
            <span className="text-xs text-muted-foreground">{description}</span>
            {args.length > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground/70">({args.join(", ")})</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function OperationFields({ op }: { op: Record<string, unknown> }) {
  const title = typeof op.title === "string" ? op.title : ""
  const name = typeof op.name === "string" ? op.name : ""
  const method = typeof op.method === "string" ? op.method : ""
  const path = typeof op.path === "string" ? op.path : ""
  const description = typeof op.description === "string" ? op.description : ""
  const pathParams = asRecord(op.pathParams) ?? {}
  const queryParams = asRecord(op.queryParams) ?? {}
  const body = typeof op.body === "string" ? op.body : ""
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm">{title || name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {method} {path}
        </span>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {Object.keys(pathParams).length > 0 && <ParamList label="Path" params={pathParams} />}
      {Object.keys(queryParams).length > 0 && <ParamList label="Query" params={queryParams} />}
      {body && body !== "none" && <p className="text-xs text-muted-foreground">{body}</p>}
    </div>
  )
}

function ParamList({ label, params }: { label: string; params: Record<string, unknown> }) {
  return (
    <div className="text-[11px]">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono">{Object.keys(params).join(", ")}</span>
    </div>
  )
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const plain = (value: unknown): string => (typeof value === "string" ? value : safeStringify(value))

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
