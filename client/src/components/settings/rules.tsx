import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Globe,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react"
import { useRules, useCreateRule, useUpdateRule, useDeleteRule, type Rule } from "@/lib/queries/catalog"
import { useInvalidate } from "@/lib/queries/helpers"
import { rulesKey } from "@/lib/queries/keys"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { captureError, type InlineError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useTableFilter } from "@/lib/use-table-filter"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { ErrorNote } from "@/components/error-note"
import { Field, FormPageHeader, FormSection, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/* ── Rules ──
   Individual standing instructions every thread spawns with — beneath any
   project's own rules, folded into the spawn by server/src/rules.ts through the
   door each runtime already opens. Each rule has a title and content so they
   can be managed individually rather than as one blob.

   Layout: the table IS the order the rules are read in (row actions move and
   delete); a row opens ONE roomy editor on a route page of its own
   (`RuleFormPage`, /settings/rules/:entryId) at every width.
   Edits save as they are typed (there is no Save button to forget), so the
   editor says, in one place and in words, what the last write did. */

type RuleRow = Rule & { n: number }

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? ""
const lineCount = (s: string) => (s ? s.split("\n").length : 0)

/** What the last write did — the Save/Discard question, answered without a button. */
function SaveState({ pending, failed, saved }: { pending: boolean; failed: boolean; saved: boolean }) {
  const [Icon, text, tone] = pending
    ? [Spinner, "Saving…", "text-muted-foreground"]
    : failed
      ? [AlertCircle, "Not saved", "text-destructive"]
      : saved
        ? [Check, "Saved", "text-success"]
        : [null, "Edits save as you type", "text-muted-foreground"]
  return (
    <span aria-live="polite" className={cn("inline-flex items-center gap-1.5 text-sm", tone)}>
      {Icon && <Icon className="size-3.5" aria-hidden />}
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
          className="max-h-[50dvh] min-h-56 resize-y overflow-y-auto font-mono text-sm"
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
  const navigate = useNavigate()
  const invalidate = useInvalidate()
  const { settings } = useSettingsPage()

  /* Rules autosave, so a new one exists on the server before its page does:
     the list is re-read first, or the page would find no such id and bounce. */
  const addRule = () => {
    createRule.mutate(
      { projectId: null, title: "New rule", content: "" },
      {
        onSuccess: async (created) => {
          await invalidate(rulesKey(settings))
          void navigate(settingsFormPath("rules", created.id))
        },
        onError: (err) => setError(captureError(err, "Couldn't add a rule")),
      },
    )
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
  const f = useTableFilter(rows, { text: (r) => `${r.title}\n${r.content}`, placeholder: "Search rules…" })

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

  return (
    <>
      <PageHeader meta={meta} action={addButton} />
      <div className="space-y-4">
        <ErrorNote error={error} />
        <DataTable<RuleRow, unknown>
          className="min-w-0"
          columns={columns}
          data={f.rows}
          getRowId={(r) => r.id}
          pageSize={50}
          actions={actions}
          mark={() => <Globe aria-hidden />}
          onRowClick={(r) => void navigate(settingsFormPath("rules", r.id))}
          filtering={f.filtering}
          emptyIcon={<ScrollText />}
          emptyMessage={
            f.narrowed ? `Nothing matches “${f.query.trim()}”.` : "No rules yet."
          }
          emptyAction={f.narrowed ? undefined : addButton}
        />
      </div>

    </>
  )
}

/** One rule on a page of its own. Edits save as they are typed. */
export function RuleFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const rules = useRules()
  const updateRule = useUpdateRule()
  const deleteRule = useDeleteRule()
  const [error, setError] = React.useState<InlineError | null>(null)
  const idx = rules.findIndex((r) => r.id === entryId)
  const rule = idx === -1 ? undefined : rules[idx]
  /* A rule deleted here or on another device has no page. */
  if (!rule) return <Navigate to={settingsPath("rules")} replace />
  const back = () => void navigate(settingsPath("rules"))
  const total = rules.length

  const onField = (field: "title" | "content", value: string) =>
    updateRule.mutate({ id: rule.id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the rule")),
    })

  const move = (direction: "up" | "down") => {
    const other = rules[direction === "up" ? idx - 1 : idx + 1]
    if (!other) return
    for (const [a, b] of [[rule, other], [other, rule]])
      updateRule.mutate(
        { id: a.id, sortOrder: b.sortOrder },
        { onError: (err) => setError(captureError(err, "Couldn't reorder rules")) },
      )
  }

  return (
    <>
      <FormPageHeader title={`Rule ${idx + 1} of ${total}`} onBack={back} />
      <div className="space-y-6">
        <ErrorNote error={error} />
        <FormSection
          label="Rule"
          action={
            <SaveState pending={updateRule.isPending} failed={updateRule.isError} saved={updateRule.isSuccess} />
          }
        >
          <Fields rule={rule} onField={onField} />
        </FormSection>
        <div className="flex items-center justify-between gap-2">
          <EditorActions
            idx={idx}
            total={total}
            onMove={move}
            onDelete={() =>
              deleteRule.mutate(
                { id: rule.id },
                {
                  onSuccess: back,
                  onError: (err) => setError(captureError(err, "Couldn't delete the rule")),
                },
              )
            }
          />
          <Button className="h-11 @panel-sm:h-9" onClick={back}>
            Done
          </Button>
        </div>
      </div>
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
