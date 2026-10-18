import * as React from "react"
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Globe,
  Loader2,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react"
import { useRules, useCreateRule, useUpdateRule, useDeleteRule, type Rule } from "@/lib/queries/catalog"
import { captureError, type InlineError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { ErrorNote } from "@/components/error-note"
import { DetailSheet, Field, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/* ── Rules ──
   Individual standing instructions every thread spawns with — beneath any
   project's own rules, folded into the spawn by server/src/rules.ts through the
   door each runtime already opens. Each rule has a title and content so they
   can be managed individually rather than as one blob.

   Layout: the table IS the order the rules are read in (row actions move and
   delete); a row opens ONE roomy editor in a DetailSheet at every width.
   Edits save as they are typed (there is no Save button to forget), so the
   editor says, in one place and in words, what the last write did. */

type RuleRow = Rule & { n: number }

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? ""
const lineCount = (s: string) => (s ? s.split("\n").length : 0)

/** What the last write did — the Save/Discard question, answered without a button. */
function SaveState({ pending, failed, saved }: { pending: boolean; failed: boolean; saved: boolean }) {
  const [Icon, text, tone] = pending
    ? [Loader2, "Saving…", "text-muted-foreground"]
    : failed
      ? [AlertCircle, "Not saved", "text-destructive"]
      : saved
        ? [Check, "Saved", "text-success"]
        : [null, "Edits save as you type", "text-muted-foreground"]
  return (
    <span aria-live="polite" className={cn("inline-flex items-center gap-1.5 text-xs", tone)}>
      {Icon && <Icon className={cn("size-3.5", pending && "animate-spin")} aria-hidden />}
      {text}
    </span>
  )
}

function Fields({
  rule,
  onField,
}: {
  rule: Rule
  onField: (field: "title" | "content", value: string) => void
}) {
  return (
    <>
      <Field label="Title">
        <Input
          value={rule.title}
          onChange={(e) => onField("title", e.target.value)}
          placeholder="Rule title"
          aria-label="Rule title"
          className="pointer-coarse:h-11"
        />
      </Field>
      <Field
        label="Content"
        hint={`${rule.content.length.toLocaleString()} chars · ${lineCount(rule.content)} lines`}
      >
        <Textarea
          value={rule.content}
          onChange={(e) => onField("content", e.target.value)}
          aria-label="Rule content"
          className="max-h-[50dvh] min-h-56 resize-y overflow-y-auto font-mono text-xs"
          placeholder="Standing instruction for the agent…"
        />
      </Field>
    </>
  )
}

export function RulesPage() {
  const meta = sectionMeta("rules")
  const rules = useRules()
  const createRule = useCreateRule()
  const updateRule = useUpdateRule()
  const deleteRule = useDeleteRule()
  const [error, setError] = React.useState<InlineError | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  /* A selection that no longer exists (deleted here or on another device)
     closes the sheet rather than drawing an empty editor. */
  const idx = rules.findIndex((r) => r.id === selectedId)
  const rule = idx === -1 ? undefined : rules[idx]

  /* A sheet left open over a rule that vanished would reopen by itself when
     a rule came back. */
  React.useEffect(() => {
    if (!rule) setSheetOpen(false)
  }, [rule])

  const addRule = () => {
    createRule.mutate(
      { projectId: null, title: "New rule", content: "" },
      {
        onSuccess: (created) => {
          setSelectedId(created.id)
          setSheetOpen(true)
        },
        onError: (err) => setError(captureError(err, "Couldn't add a rule")),
      },
    )
  }

  const updateField = (id: string, field: "title" | "content", value: string) => {
    updateRule.mutate({ id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the rule")),
    })
  }

  const removeRule = (id: string) => {
    deleteRule.mutate({ id }, {
      onError: (err) => setError(captureError(err, "Couldn't delete the rule")),
    })
  }

  const moveRule = (id: string, direction: "up" | "down") => {
    const idx = rules.findIndex((r) => r.id === id)
    if (idx === -1) return
    const swapIdx = direction === "up" ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rules.length) return
    const [a, b] = [rules[idx], rules[swapIdx]]
    updateRule.mutate(
      { id: a.id, sortOrder: b.sortOrder },
      { onError: (err) => setError(captureError(err, "Couldn't reorder rules")) },
    )
    updateRule.mutate(
      { id: b.id, sortOrder: a.sortOrder },
      { onError: (err) => setError(captureError(err, "Couldn't reorder rules")) },
    )
  }

  /* The table memoises its rows against the columns and actions, and `rules`
     changes on every keystroke — so they read the handlers through a ref and
     stay put. */
  const handlers = React.useRef({ moveRule, removeRule })
  handlers.current = { moveRule, removeRule }
  const total = rules.length

  const rows = React.useMemo<RuleRow[]>(() => rules.map((r, i) => ({ ...r, n: i + 1 })), [rules])
  const shown = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? rows.filter((r) => `${r.title}\n${r.content}`.toLowerCase().includes(needle))
      : rows
  }, [rows, query])

  const columns = React.useMemo<ColumnDef<RuleRow, unknown>[]>(
    () => [
      {
        id: "rule",
        header: "Rule",
        cell: ({ row }) => (
          <TitleCell
            title={`${row.original.n}. ${row.original.title.trim() || "Untitled rule"}`}
            subtitle={firstLine(row.original.content) || "Empty"}
          />
        ),
        meta: { title: true },
      },
      {
        id: "scope",
        header: "Scope",
        cell: () => "All threads",
        meta: { className: "hidden @panel-md:table-cell w-32" },
      },
      {
        id: "length",
        header: "Length",
        cell: ({ row }) => `${row.original.content.length.toLocaleString()} chars`,
        meta: { align: "end", className: "w-28" },
      },
    ],
    [],
  )

  const actions = React.useMemo<TableAction<RuleRow>[]>(
    () => [
      {
        id: "up",
        label: "Move up",
        icon: <ChevronUp className="size-4" />,
        position: "left",
        disabled: (r) => r.n === 1,
        onClick: (r) => handlers.current.moveRule(r.id, "up"),
      },
      {
        id: "down",
        label: "Move down",
        icon: <ChevronDown className="size-4" />,
        position: "left",
        disabled: (r) => r.n === total,
        onClick: (r) => handlers.current.moveRule(r.id, "down"),
      },
      {
        id: "delete",
        label: "Delete rule",
        icon: <Trash2 className="size-4" />,
        tone: "danger",
        onClick: (r) => {
          handlers.current.removeRule(r.id)
        },
      },
    ],
    [total],
  )

  const addButton = (
    <Button className="h-11 @panel-sm:h-9" onClick={addRule} disabled={createRule.isPending}>
      <Plus className="size-4" /> New rule
    </Button>
  )

  const saveState = (
    <SaveState pending={updateRule.isPending} failed={updateRule.isError} saved={updateRule.isSuccess} />
  )

  const onField = (field: "title" | "content", value: string) => rule && updateField(rule.id, field, value)

  return (
    <>
      <PageHeader meta={meta} action={addButton} />
      <div className="space-y-4">
        <ErrorNote error={error} />
        <DataTable<RuleRow, unknown>
          className="min-w-0"
          columns={columns}
          data={shown}
          getRowId={(r) => r.id}
          pageSize={50}
          actions={actions}
          mark={() => <Globe aria-hidden />}
          onRowClick={(r) => {
            setSelectedId(r.id)
            setSheetOpen(true)
          }}
          filtering={{
            search: { value: query, onChange: setQuery, placeholder: "Search rules…" },
            totalCount: rows.length,
          }}
          emptyIcon={<ScrollText />}
          emptyMessage={
            query.trim() ? `Nothing matches “${query.trim()}”.` : "No rules yet."
          }
          emptyAction={query.trim() ? undefined : addButton}
        />
      </div>

      <DetailSheet
        open={sheetOpen && !!rule}
        onOpenChange={setSheetOpen}
        title={`Rule ${idx + 1} of ${total}`}
        description={saveState}
        footer={
          rule && (
            <>
              <EditorActions
                idx={idx}
                total={total}
                onMove={(d) => moveRule(rule.id, d)}
                onDelete={() => {
                  removeRule(rule.id)
                  setSheetOpen(false)
                }}
              />
              <Button className="h-11" onClick={() => setSheetOpen(false)}>
                Done
              </Button>
            </>
          )
        }
      >
        {rule && <Fields rule={rule} onField={onField} />}
      </DetailSheet>
    </>
  )
}

function EditorActions({
  idx,
  total,
  onMove,
  onDelete,
}: {
  idx: number
  total: number
  onMove: (direction: "up" | "down") => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="pointer-coarse:size-11"
        onClick={() => onMove("up")}
        disabled={idx === 0}
        title="Move up"
        aria-label="Move up"
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="pointer-coarse:size-11"
        onClick={() => onMove("down")}
        disabled={idx === total - 1}
        title="Move down"
        aria-label="Move down"
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-destructive pointer-coarse:size-11"
        onClick={onDelete}
        title="Delete rule"
        aria-label="Delete rule"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}
