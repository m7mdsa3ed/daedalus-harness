import * as React from "react"
import { ArrowDown, ArrowUp, BotIcon, Download, PlugZap, Plus, Trash2 } from "lucide-react"
import { toast } from "@/lib/toast"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import { useTableFilter } from "@/lib/use-table-filter"
import type { ColumnDef } from "@/lib/table"
import { ErrorNote } from "@/components/error-note"
import { EntityIcon } from "@/components/entity-icon"
import { captureError, type InlineError } from "@/lib/errors"
import { api, type ModelCandidate, type ModelKind, type ModelWire, type ServerSettings } from "@/lib/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { PickerSkeleton } from "@/components/ui/skeletons"
import { cn } from "@/lib/utils"
import { FIELD_GRID, Field, INSET, LogoUpload, Picker } from "./primitives"

/* ── model rows (reference: profile-models.ts) ──
   The form edits rows and converts to ModelOption[] on save. Numbers live as
   strings in the rows: a half-typed number is a normal editing state. The
   models.dev-derived fields ride the same rule, and `devRef` remembers where
   an entry's metadata came from so it can be re-looked-up — it is dropped the
   moment the id is edited away from the enriched one. */

export interface ModelRow {
  uid: string
  id: string
  label: string
  contextWindow: string
  maxOutputTokens: string
  /** Comma-separated effort levels; empty = the model has no effort control. */
  efforts: string
  pricingInput: string
  pricingOutput: string
  modalities: string
  devRef: string
  iconUrl: string
  group: string
  /** Model-role ids this model serves (`ModelRole.id`). */
  roles: string[]
  /** What the model is (docs/plans/model-kinds.md). A chat model is offered for
      a thread; a decision or completion model is called by a wire instead and
      never appears in a thread's picker. */
  kind: ModelKind
  /** How a non-chat model is called. Empty on a chat model. */
  wire: ModelWire | ""
}

let modelUid = 0
export const blankModelRow = (): ModelRow => ({
  uid: `model-${++modelUid}`,
  id: "",
  label: "",
  contextWindow: "",
  maxOutputTokens: "",
  efforts: "",
  pricingInput: "",
  pricingOutput: "",
  modalities: "",
  devRef: "",
  iconUrl: "",
  group: "",
  roles: [],
  kind: "chat",
  wire: "",
})

export const candidateToRow = (candidate: ModelCandidate): ModelRow => ({
  uid: `model-${++modelUid}`,
  id: candidate.id,
  // The id doubles as the label when there is nothing better; don't echo it
  // into the field, or clearing it becomes impossible.
  label: candidate.label && candidate.label !== candidate.id ? candidate.label : "",
  contextWindow: candidate.contextWindow ? String(candidate.contextWindow) : "",
  maxOutputTokens: candidate.maxOutputTokens ? String(candidate.maxOutputTokens) : "",
  efforts: candidate.reasoningEfforts.join(", "),
  pricingInput: candidate.pricing ? String(candidate.pricing.input) : "",
  pricingOutput: candidate.pricing ? String(candidate.pricing.output) : "",
  modalities: (candidate.modalities ?? []).join(", "),
  devRef: candidate.devRef ?? "",
  iconUrl: candidate.iconUrl ?? "",
  group: candidate.group ?? "",
  roles: candidate.roles ?? [],
  kind: candidate.kind ?? "chat",
  wire: candidate.wire ?? "",
})

export const toModelRows = (models: {
  id: string
  label: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEfforts: string[]
  pricing?: { input: number; output: number }
  modalities?: string[]
  devRef?: string
  iconUrl?: string
  group?: string
  roles?: string[]
  kind?: ModelKind
  wire?: ModelWire
}[]): ModelRow[] =>
  models.map((m) => ({
    uid: `model-${++modelUid}`,
    id: m.id,
    label: m.label && m.label !== m.id ? m.label : "",
    contextWindow: m.contextWindow ? String(m.contextWindow) : "",
    maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : "",
    efforts: m.reasoningEfforts.join(", "),
    pricingInput: m.pricing ? String(m.pricing.input) : "",
    pricingOutput: m.pricing ? String(m.pricing.output) : "",
    modalities: (m.modalities ?? []).join(", "),
    devRef: m.devRef ?? "",
    iconUrl: m.iconUrl ?? "",
    group: m.group ?? "",
    roles: m.roles ?? [],
    kind: m.kind ?? "chat",
    wire: m.wire ?? "",
  }))

export function rowsToModels(rows: ModelRow[]) {
  const models: {
    id: string
    label: string
    contextWindow?: number
    maxOutputTokens?: number
    reasoningEfforts: string[]
    pricing?: { input: number; output: number }
    modalities?: string[]
    devRef?: string
    iconUrl?: string
    group?: string
    roles?: string[]
    kind?: ModelKind
    wire?: ModelWire
  }[] = []
  for (const row of rows) {
    const id = row.id.trim()
    if (!id) continue
    const context = Number(row.contextWindow.trim())
    const maxOut = Number(row.maxOutputTokens.trim())
    const pricingInput = Number(row.pricingInput.trim())
    const pricingOutput = Number(row.pricingOutput.trim())
    const modalities = row.modalities
      .split(/[,\s]+/)
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean)
    models.push({
      id,
      label: row.label.trim() || id,
      ...(row.contextWindow.trim() && context > 0 ? { contextWindow: Math.round(context) } : {}),
      ...(row.maxOutputTokens.trim() && maxOut > 0 ? { maxOutputTokens: Math.round(maxOut) } : {}),
      reasoningEfforts: row.efforts
        .split(/[,\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
      ...(row.pricingInput.trim() &&
      row.pricingOutput.trim() &&
      pricingInput > 0 &&
      pricingOutput > 0
        ? { pricing: { input: pricingInput, output: pricingOutput } }
        : {}),
      ...(modalities.length ? { modalities } : {}),
      ...(row.devRef.trim() ? { devRef: row.devRef.trim() } : {}),
      ...(row.iconUrl.trim() ? { iconUrl: row.iconUrl.trim() } : {}),
      ...(row.group.trim() ? { group: row.group.trim() } : {}),
      ...(row.roles.length ? { roles: row.roles } : {}),
      /* A chat model is the default and stays absent, so an entry from before
         kinds existed and an entry saved today are byte-identical. */
      ...(row.kind !== "chat" ? { kind: row.kind } : {}),
      ...(row.kind !== "chat" && row.wire ? { wire: row.wire } : {}),
    })
  }
  return models
}

/* ── summary formatting ── */

const trimNum = (n: number) => String(Number(n.toFixed(2)))

const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

const summaryBadges = (row: ModelRow) => {
  const badges: string[] = []
  if (row.kind !== "chat") badges.push(row.wire ? `${row.kind} · ${row.wire}` : row.kind)
  const context = Number(row.contextWindow.trim())
  if (context > 0) badges.push(`${formatTokens(Math.round(context))} context`)
  if (row.pricingInput.trim() && row.pricingOutput.trim())
    badges.push(`$${trimNum(Number(row.pricingInput))} / $${trimNum(Number(row.pricingOutput))} per Mtok`)
  const efforts = row.efforts.split(/[,\s]+/).filter(Boolean)
  if (efforts.length) badges.push(`efforts: ${efforts.join(" · ")}`)
  const modalities = row.modalities.split(/[,\s]+/).filter((m) => m && m !== "text")
  if (modalities.length) badges.push(`text + ${modalities.join(", ")}`)
  return badges
}

/* ── the list ──
   The rows as a compact table: a model is its mark, its name over its id, then
   the numbers that tell one from another. Tapping a row opens its editor in a
   dialog (a sheet on a phone) — the editor is a form of its own and an
   accordion row cannot hold one on a narrow list. */

/** A row plus what the table cannot read off it: where it sits in the whole
    list (the reorder acts on that, not on the page's index) and whether it is
    the profile's default. */
interface ModelItem {
  row: ModelRow
  index: number
  last: boolean
  isDefault: boolean
}

const modelMark = (row: ModelRow) => (
  <EntityIcon src={row.iconUrl} fallback={<BotIcon className="size-4 text-muted-foreground" />} className="size-5" />
)

function ModelName({ item }: { item: ModelItem }) {
  const { row, isDefault } = item
  return (
    <TitleCell
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={row.id}>
            {row.label.trim() || "Unnamed model"}
          </span>
          {isDefault && (
            <Badge variant="secondary">
              default
            </Badge>
          )}
        </span>
      }
      subtitle={<span className="font-mono text-xs">{row.id.trim() || "no id yet"}</span>}
    />
  )
}

const Dash = () => <span className="text-muted-foreground">—</span>

const MODEL_COLUMNS: ColumnDef<ModelItem, unknown>[] = [
  {
    id: "model",
    header: "Model",
    cell: ({ row }) => <ModelName item={row.original} />,
    meta: { title: true, className: "min-w-52" },
  },
  {
    id: "context",
    header: "Context",
    cell: ({ row }) => {
      const context = Number(row.original.row.contextWindow.trim())
      return context > 0 ? <span className="text-sm">{formatTokens(Math.round(context))}</span> : <Dash />
    },
    meta: { align: "end", className: "hidden @panel-sm:table-cell w-24" },
  },
  {
    id: "pricing",
    header: "$ in / out",
    cell: ({ row }) => {
      const { pricingInput, pricingOutput } = row.original.row
      return pricingInput.trim() && pricingOutput.trim() ? (
        <span className="whitespace-nowrap text-sm">
          ${trimNum(Number(pricingInput))} / ${trimNum(Number(pricingOutput))}
        </span>
      ) : (
        <Dash />
      )
    },
    meta: { align: "end", className: "hidden @panel-md:table-cell w-32" },
  },
  {
    id: "efforts",
    header: "Efforts",
    cell: ({ row }) => {
      const efforts = row.original.row.efforts.split(/[,\s]+/).filter(Boolean)
      return efforts.length ? (
        <span className="text-sm text-muted-foreground">{efforts.join(" · ")}</span>
      ) : (
        <Dash />
      )
    },
    meta: { className: "hidden @panel-lg:table-cell" },
  },
  {
    id: "group",
    header: "Group",
    cell: ({ row }) =>
      row.original.row.group.trim() ? (
        <Badge variant="outline" className="max-w-40 font-normal">
          <span className="truncate">{row.original.row.group.trim()}</span>
        </Badge>
      ) : (
        <Dash />
      ),
    meta: { className: "hidden @panel-lg:table-cell" },
  },
]

/** The narrow row: name over id, then the same facts the columns carry, as
    chips — a phone has no columns to read them from. */
function ModelRowCard({ item }: { item: ModelItem }) {
  const { row, isDefault } = item
  const badges = summaryBadges(row)
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {modelMark(row)}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{row.label.trim() || "Unnamed model"}</span>
          {isDefault && (
            <Badge variant="secondary">
              default
            </Badge>
          )}
        </div>
        <span className="block truncate font-mono text-xs text-muted-foreground">{row.id.trim() || "no id yet"}</span>
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {badges.map((badge) => (
              <Badge key={badge} variant="outline" className="font-normal break-words text-muted-foreground">
                {badge}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const modelRowId = (item: ModelItem) => item.row.uid
const modelItemMark = (item: ModelItem) => modelMark(item.row)

const MODEL_MOBILE = { renderRow: (item: ModelItem) => <ModelRowCard item={item} /> }

/* ── the section ── */

export function ModelsSection({
  rows,
  defaultModel,
  settings,
  profileId,
  baseUrl,
  apiKey,
  onPatch,
  onSetDefault,
  onRemove,
  onAdd,
  onImport,
  onReorder,
}: {
  rows: ModelRow[]
  defaultModel: string
  settings: ServerSettings
  /** The saved profile's id, or "new" while the profile is still a draft —
      the fetch route takes credentials from the body either way. */
  profileId: string
  /** The form's live credentials: the same base URL and key the profile
      itself uses — a draft fetches with what is typed here, a saved one falls
      back to its stored key when the field is empty. */
  baseUrl: string
  apiKey: string
  onPatch: (uid: string, patch: Partial<ModelRow>) => void
  onSetDefault: (uid: string) => void
  onRemove: (uid: string) => void
  onAdd: () => void
  /** Rows the fetch dialog finished with — already filled from models.dev
      where the user asked, so the form only has to append them. */
  onImport: (rows: ModelRow[]) => void
  /** Reorder the rows — receives the full new order. */
  onReorder: (rows: ModelRow[]) => void
}) {
  const [editingUid, setEditingUid] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)

  /* The groups this profile already uses — the dropdown's stock, in first-seen
     order. A name typed that isn't here becomes a group by being saved. */
  const groups = [...new Set(rows.map((r) => r.group.trim()).filter(Boolean))]

  const patch = (uid: string, p: Partial<ModelRow>) => {
    // Editing the id invalidates the metadata's provenance: it described the
    // old id, and a stale devRef would survive an id it never matched.
    const row = rows.find((r) => r.uid === uid)
    if (p.id !== undefined && row && p.id !== row.id && p.devRef === undefined) p = { ...p, devRef: "" }
    onPatch(uid, p)
  }

  const items = React.useMemo<ModelItem[]>(
    () =>
      rows.map((row, index) => ({
        row,
        index,
        last: index === rows.length - 1,
        isDefault: row.id.trim() !== "" && row.id.trim() === defaultModel,
      })),
    [rows, defaultModel]
  )

  const f = useTableFilter(items, {
    text: (item) => `${item.row.label} ${item.row.id}`,
    placeholder: "Search models…",
    fields: [{ id: "effort", label: "Efforts", of: (item) => (item.row.efforts.trim() ? "Has efforts" : "No efforts") }],
  })

  /* The actions are memoised (the table memoises its rows against them), so the
     callbacks they reach are read through a ref refreshed every render. */
  const live = React.useRef({ rows, onReorder, onRemove })
  live.current = { rows, onReorder, onRemove }
  const move = (item: ModelItem, by: -1 | 1) => {
    const next = [...live.current.rows]
    const to = item.index + by
    /* The phone's swipe rail does not honour `disabled`, so the ends are
       guarded here: a swap past either one would write `undefined` into a row. */
    if (to < 0 || to >= next.length) return
    ;[next[to], next[item.index]] = [next[item.index], next[to]]
    live.current.onReorder(next)
  }
  const actions = React.useMemo<TableAction<ModelItem>[]>(
    () => [
      {
        id: "up",
        label: "Move up",
        icon: <ArrowUp />,
        position: "left",
        disabled: (item) => item.index === 0,
        onClick: (item) => move(item, -1),
      },
      {
        id: "down",
        label: "Move down",
        icon: <ArrowDown />,
        position: "left",
        disabled: (item) => item.last,
        onClick: (item) => move(item, 1),
      },
      {
        id: "remove",
        label: "Remove model",
        icon: <Trash2 />,
        tone: "danger",
        onClick: (item) => live.current.onRemove(item.row.uid),
      },
    ],
    // `move` only reads the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const openRow = React.useCallback((item: ModelItem) => setEditingUid(item.row.uid), [])

  /* A new row is blank and lands at the end of the list — on a long list, a
     page the reader is not on. Open its editor, which is what Add is for. */
  const adding = React.useRef(false)
  React.useEffect(() => {
    if (!adding.current) return
    adding.current = false
    const newest = rows[rows.length - 1]
    if (newest) setEditingUid(newest.uid)
  }, [rows])

  const editing = editingUid ? rows.find((r) => r.uid === editingUid) : undefined
  const editingDefault = editing ? editing.id.trim() !== "" && editing.id.trim() === defaultModel : false

  return (
    /* The section around it (profiles.tsx `FormSection`) carries the title and the
       sentence the Field used to; this is the body. */
    <>
      <DataTable
        columns={MODEL_COLUMNS}
        data={f.rows}
        getRowId={modelRowId}
        actions={actions}
        mobile={MODEL_MOBILE}
        mark={modelItemMark}
        filtering={f.filtering}
        pageSize={25}
        onRowClick={openRow}
        emptyIcon={<BotIcon />}
        emptyMessage={
          f.narrowed
            ? undefined
            : "No models — this profile lets the agent use its own catalog. Add or fetch models to override it."
        }
        toolbar={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              title="Add model"
              aria-label="Add model"
              onClick={() => {
                adding.current = true
                onAdd()
              }}
            >
              <Plus data-icon="inline-start" /> Add
            </Button>
            {/* Opens the panel below, which fetches at once — there is no source
                to choose: the only one is the provider behind this profile's
                credentials, and it needs a base URL to be asked. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={!baseUrl.trim()}
              title={baseUrl.trim() ? "Fetch models from the provider" : "Add a base URL first"}
              aria-label="Fetch models"
              onClick={() => setImporting(true)}
            >
              <Download data-icon="inline-start" /> Fetch
            </Button>
          </div>
        }
      />
      <ResponsiveDialog open={editing !== undefined} onOpenChange={(open) => !open && setEditingUid(null)}>
        <ResponsiveDialogContent className="sm:max-w-2xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Edit model</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Changes apply to the form at once; they are saved with the profile.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          {editing && (
            <div className="@container">
              <ModelEditorFields
                row={editing}
                isDefault={editingDefault}
                groups={groups}
                onSetDefault={() => onSetDefault(editing.uid)}
                settings={settings}
                profileId={profileId}
                baseUrl={baseUrl}
                apiKey={apiKey}
                onPatch={(p) => patch(editing.uid, p)}
              />
            </div>
          )}
          <ResponsiveDialogFooter>
            <Button type="button" onClick={() => setEditingUid(null)}>
              Done
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      {importing && (
        <FetchModelsDialog
          settings={settings}
          profileId={profileId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          existingIds={rows.map((r) => r.id.trim()).filter(Boolean)}
          onImport={(imported) => {
            onImport(imported)
            setImporting(false)
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </>
  )
}

/* ── per-model editor (drawn in the dialog above) ── */

function ModelEditorFields({
  row,
  isDefault,
  groups,
  onSetDefault,
  settings,
  profileId,
  baseUrl,
  apiKey,
  onPatch,
}: {
  row: ModelRow
  isDefault: boolean
  /** Group names already used by this profile's rows — the picker's stock. */
  groups: string[]
  onSetDefault: () => void
  settings: ServerSettings
  profileId: string
  baseUrl: string
  apiKey: string
  onPatch: (patch: Partial<ModelRow>) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <EntityIcon
            src={row.iconUrl}
            fallback={<BotIcon className="size-5 text-muted-foreground" />}
            className="size-6 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              Editing {row.label.trim() || row.id.trim() || "model"}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {row.id.trim() || "No model ID configured"}
            </span>
          </div>
        </div>
        <Button
          type="button"
          variant={isDefault ? "secondary" : "outline"}
          size="sm"
          className="w-full pointer-coarse:h-11 @panel-sm:w-auto"
          onClick={onSetDefault}
        >
          {isDefault ? "Default model" : "Set as default"}
        </Button>
      </div>
      <div className={FIELD_GRID}>
        <Field label="Model id">
          <Input
            value={row.id}
            onChange={(e) => onPatch({ id: e.target.value })}
            placeholder="claude-opus-5"
            className="font-mono"
          />
        </Field>
        <Field label="Display name" hint="Empty = the id.">
          <Input
            value={row.label}
            onChange={(e) => onPatch({ label: e.target.value })}
            placeholder="Claude Opus 5"
          />
        </Field>
        <Field
          label="Kind"
          hint="What the model is. A chat model is offered for a thread; decision and completion models are called by their wire and never appear in a thread's picker."
        >
          <Select
            value={row.kind}
            onValueChange={(value: ModelKind | null) =>
              onPatch({ kind: (value ?? "chat") as ModelKind, ...(value && value !== "chat" ? {} : { wire: "" as const }) })
            }
          >
            <SelectTrigger className="w-full" aria-label="Model kind">
              <SelectValue>{row.kind}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">chat — a thread's model</SelectItem>
              <SelectItem value="decision">decision — typed questions</SelectItem>
              <SelectItem value="completion">completion — fill the middle</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {row.kind !== "chat" && (
          <Field
            label="Wire"
            hint="The protocol this model speaks. A definition cannot run a model with no wire."
          >
            <Select
              value={row.wire || null}
              onValueChange={(value: string | null) => onPatch({ wire: (value ?? "") as ModelWire | "" })}
            >
              <SelectTrigger className="w-full" aria-label="Model wire">
                <SelectValue>{row.wire || "Pick a wire"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {row.kind === "decision" ? (
                  <>
                    <SelectItem value="systemone">systemone — /v1/systemone</SelectItem>
                    <SelectItem value="systemone-gateway">systemone-gateway — /v1/decisions</SelectItem>
                  </>
                ) : (
                  <SelectItem value="openai-completions">openai-completions — prompt + suffix</SelectItem>
                )}
              </SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Context window" hint="Tokens.">
          <Input
            type="number"
            value={row.contextWindow}
            onChange={(e) => onPatch({ contextWindow: e.target.value })}
            placeholder="200000"
            className="text-left @panel-sm:text-right font-mono"
          />
        </Field>
        <Field label="Max output tokens">
          <Input
            type="number"
            value={row.maxOutputTokens}
            onChange={(e) => onPatch({ maxOutputTokens: e.target.value })}
            placeholder="64000"
            className="text-left @panel-sm:text-right font-mono"
          />
        </Field>
        <Field label="Reasoning efforts" hint="Comma-separated; empty = no effort control.">
          <Input
            value={row.efforts}
            onChange={(e) => onPatch({ efforts: e.target.value })}
            placeholder="low, medium, high"
            className="font-mono"
          />
        </Field>
        <Field label="Input modalities" hint="Comma-separated.">
          <Input
            value={row.modalities}
            onChange={(e) => onPatch({ modalities: e.target.value })}
            placeholder="text, image"
            className="font-mono"
          />
        </Field>
        <Field label="Price in (USD / Mtok)">
          <Input
            type="number"
            step="any"
            min="0"
            value={row.pricingInput}
            onChange={(e) => onPatch({ pricingInput: e.target.value })}
            placeholder="3"
            className="text-left @panel-sm:text-right font-mono"
          />
        </Field>
        <Field label="Price out (USD / Mtok)">
          <Input
            type="number"
            step="any"
            min="0"
            value={row.pricingOutput}
            onChange={(e) => onPatch({ pricingOutput: e.target.value })}
            placeholder="15"
            className="text-left @panel-sm:text-right font-mono"
          />
        </Field>
        <div className="@panel-sm:col-span-2">
          <Field label="Icon URL" hint="Optional — shown in the composer trigger when this model is selected.">
            <div className="flex items-center gap-2">
              <EntityIcon
                src={row.iconUrl}
                fallback={<BotIcon className="size-5 text-muted-foreground" />}
                className="size-5 shrink-0"
              />
              <Input
                value={row.iconUrl.startsWith("data:") ? "" : row.iconUrl}
                onChange={(e) => onPatch({ iconUrl: e.target.value })}
                placeholder={row.iconUrl.startsWith("data:") ? "Uploaded image" : "https://models.dev/logos/anthropic.svg"}
                className="min-w-0 flex-1 font-mono"
              />
              <LogoUpload value={row.iconUrl} onChange={(iconUrl) => onPatch({ iconUrl })} />
            </div>
          </Field>
        </div>
        <div className="@panel-sm:col-span-2">
          <Field
            label="Group"
            hint="Pick one this profile already uses, or type a new name. Models sharing a group appear under a shared heading in the picker."
          >
            <GroupPicker row={row} groups={groups} onPatch={onPatch} />
          </Field>
        </div>
      </div>
      <ModelTest row={row} settings={settings} profileId={profileId} baseUrl={baseUrl} apiKey={apiKey} />
      <ModelsDevMatch row={row} settings={settings} onPatch={onPatch} />
    </div>
  )
}

/* ── the model test ──
   The listing route proves an id exists; this runs it. One tiny completion
   through the profile's own credentials, carrying the row's own max output
   tokens, because a cap the provider rejects is a 400 on every turn and is
   invisible until one is spent — the failure this was written for. Nothing is
   saved and nothing is patched: the provider's own words are the result. */

function ModelTest({
  row,
  settings,
  profileId,
  baseUrl,
  apiKey,
}: {
  row: ModelRow
  settings: ServerSettings
  profileId: string
  baseUrl: string
  apiKey: string
}) {
  const [testing, setTesting] = React.useState(false)
  const [result, setResult] = React.useState<{ ms: number; reply: string; finishReason?: string } | null>(null)
  const [error, setError] = React.useState<InlineError | null>(null)
  const id = row.id.trim()
  const maxOut = Number(row.maxOutputTokens.trim())

  /* Only a chat model can be proven by this door: it sends a chat completion,
     and the other two kinds answer a different protocol entirely (the gateway's
     own refusal is "ModelProtocolUnsupported", which reads like a broken row).
     A completion model is tested through the lane that calls it — `/api/fim`,
     against this profile's *saved* credentials, since that route reads the row.
     A decision model has no lane yet, so `run` is never reached for one. */
  const completion = row.kind === "completion" && row.wire === "openai-completions"

  const run = async () => {
    setTesting(true)
    setResult(null)
    setError(null)
    try {
      if (completion) {
        const started = performance.now()
        const { text } = await api<{ text: string; model: string }>(settings, "/api/fim", {
          method: "POST",
          body: JSON.stringify({ profileId, model: id, prompt: "def hello():\n    ", maxTokens: 24 }),
        })
        setResult({ ms: performance.now() - started, reply: text.trimEnd() || "(an empty gap)" })
        return
      }
      setResult(
        await api<{ ms: number; reply: string; finishReason?: string }>(
          settings,
          `/api/profiles/${profileId}/test-model`,
          {
            method: "POST",
            body: JSON.stringify({
              model: id,
              /* The row's kind, so a model the profile does not hold yet is
                 refused by the right name instead of being sent a chat body. */
              kind: row.kind,
              ...(row.maxOutputTokens.trim() && maxOut > 0 ? { maxOutputTokens: Math.round(maxOut) } : {}),
              ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              ...(apiKey ? { apiKey } : {}),
            }),
          },
        ),
      )
    } catch (err) {
      setError(captureError(err, `${id} didn't answer`))
    } finally {
      setTesting(false)
    }
  }

  if (row.kind === "decision") {
    return (
      <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
        A decision model answers typed questions — a state plus a map of noul, choice and score
        questions — and nothing in the harness asks one yet, so there is nothing to send from here.
        The row keeps its {row.wire || "unset"} wire for the first consumer.
      </p>
    )
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          disabled={!id || !baseUrl.trim()}
          loading={testing}
          title={baseUrl.trim() ? undefined : "Add a base URL first"}
          onClick={() => void run()}
        >
          <PlugZap data-icon="inline-start" /> Test model
        </Button>
        <span className="text-xs text-muted-foreground">
          {completion
            ? "One fill-in-the-middle request, sent to this profile's saved endpoint."
            : row.maxOutputTokens.trim() && maxOut > 0
              ? `One short completion, sent with max_tokens ${Math.round(maxOut)}.`
              : "One short completion, with no output cap."}
        </span>
      </div>
      {result && (
        <p className={cn("px-2.5 py-2 text-xs text-muted-foreground", INSET)}>
          Answered in {(result.ms / 1000).toFixed(1)}s
          {result.finishReason ? ` (${result.finishReason})` : ""}
          {result.reply ? ` — “${result.reply}”` : ""}
        </p>
      )}
      {error && <ErrorNote error={error} onRetry={() => void run()} retryLabel="Test again" />}
    </div>
  )
}

/* ── group picker ──
   One control, both ways in: the dropdown lists the groups this profile
   already uses, and the field itself stays editable, so typing a name that
   matches nothing is how a new group is added. It is a combobox rather than a
   select because the value is free text — a group exists because a model
   carries it, never as a row of its own. */

function GroupPicker({
  row,
  groups,
  onPatch,
}: {
  row: ModelRow
  groups: string[]
  onPatch: (patch: Partial<ModelRow>) => void
}) {
  return (
    <Combobox
      items={groups}
      inputValue={row.group}
      onInputValueChange={(value) => onPatch({ group: typeof value === "string" ? value : "" })}
      onValueChange={(group: string | null) => {
        if (group !== null) onPatch({ group })
      }}
    >
      <ComboboxInput placeholder="e.g. Frontier, Mid-tier, Legacy" className="w-full" />
      <ComboboxContent>
        <ComboboxList>
          {groups.map((group) => (
            <ComboboxItem key={group} value={group}>
              {group}
            </ComboboxItem>
          ))}
        </ComboboxList>
        <ComboboxEmpty>No groups yet — type a name and saving the model creates it.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

/* ── models.dev match ──
   Metadata is looked up by *searching*, never by an exact-id fill. Two reasons,
   and the old one-shot button lost to both: a gateway serves its own ids
   ("oc/hy3-free"), which models.dev has never heard of even though the model
   behind them is in the catalog under its real name — an exact match can only
   report a miss it has no way to resolve; and the catalog is a 4.4 MB upstream
   fetch that fails transiently, which the button turned into an error toast
   over an editor that then knew nothing more than before. A dropdown makes both
   the same thing: type, look, pick — and a failed fetch is a Retry inside the
   popup instead of a dead end.

   The search runs server-side (the catalog never reaches the browser) and is
   seeded with the row's own id on open, because the server scores an exact id
   match first — when the gateway *does* use the catalog's id, the top row is
   already the answer and the extra typing never happens. */

function ModelsDevMatch({
  row,
  settings,
  onPatch,
}: {
  row: ModelRow
  settings: ServerSettings
  onPatch: (patch: Partial<ModelRow>) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<ModelCandidate[]>([])
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "failed">("idle")
  // Bumped to re-run the search with the query unchanged — the Retry button.
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setState("loading")
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: "30" })
      if (query.trim()) params.set("q", query.trim())
      api<{ models: ModelCandidate[] }>(settings, `/api/models-dev/search?${params}`)
        .then((r) => {
          if (cancelled) return
          setResults(r.models)
          setState("ready")
        })
        .catch((err) => {
          if (cancelled) return
          // The popup says so itself; a toast on every keystroke of a dead
          // upstream is noise on top of an answer already on screen.
          setResults([])
          setState("failed")
          console.warn("models.dev search failed", err)
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [settings, query, open, attempt])

  /** Apply a hit the user pointed at. The id is never touched — it is the
      gateway's, and it is what the agent is spawned with — and a label the user
      typed survives. Everything else is a *fact about the model just chosen*, so
      it replaces what is there: the no-clobber rule protected hand-entered
      values from a lookup nobody asked for, and this is the opposite. */
  const apply = (hit: ModelCandidate) => {
    // Every field is coerced on the way in. A row's fields are the strings a
    // controlled `<Input>` is given and `rowsToModels` calls `.trim()` on, so a
    // field the response happened not to carry must land as "", never undefined
    // — that is a blank input and a crash on the next keystroke, one bug apart.
    const label = hit.label ?? ""
    const patch: Partial<ModelRow> = {
      devRef: hit.devRef ?? (hit.providerId ? `${hit.providerId}/${hit.id}` : hit.id),
      contextWindow: hit.contextWindow ? String(hit.contextWindow) : "",
      maxOutputTokens: hit.maxOutputTokens ? String(hit.maxOutputTokens) : "",
      efforts: (hit.reasoningEfforts ?? []).join(", "),
      pricingInput: hit.pricing ? String(hit.pricing.input) : "",
      pricingOutput: hit.pricing ? String(hit.pricing.output) : "",
      modalities: (hit.modalities ?? []).join(", "),
      /* The provider's mark, derived from the hit the same way the server
         derives it — see models-dev.ts's `toCandidate`. */
      iconUrl: hit.iconUrl ?? (hit.providerId ? `https://models.dev/logos/${hit.providerId}.svg` : ""),
    }
    if (!row.label.trim() || row.label.trim() === row.id.trim())
      patch.label = label === hit.id ? "" : label
    onPatch(patch)
    setOpen(false)
  }

  const matched = row.devRef.trim()

  return (
    <div className="flex flex-col @panel-sm:flex-row @panel-sm:flex-wrap items-start @panel-sm:items-center gap-2">
      <Combobox
        items={results}
        filter={null}
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Seed on open, so the row's own id is the first thing searched.
          if (next) setQuery(row.id.trim())
        }}
        inputValue={query}
        // The combobox resets its own input on close and clear; a non-string
        // reaching state is a `.trim()` away from throwing in the effect above.
        onInputValueChange={(value) => setQuery(typeof value === "string" ? value : "")}
        itemToStringLabel={(hit: ModelCandidate | null) => hit?.label || hit?.id || ""}
        onValueChange={(hit: ModelCandidate | null) => hit && apply(hit)}
      >
        <ComboboxTrigger render={<Button type="button" variant="outline" size="sm" className="w-full pointer-coarse:h-11 @panel-sm:w-auto" />}>
          {matched ? "Change models.dev match" : "Match on models.dev"}
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput showTrigger={false} placeholder="Search models.dev…" />
          <ComboboxList>
            {results.map((hit) => (
              <ComboboxItem key={`${hit.providerId ?? "?"}:${hit.id}`} value={hit} className="items-start gap-2.5">
                <EntityIcon
                  src={hit.iconUrl ?? (hit.providerId ? `https://models.dev/logos/${hit.providerId}.svg` : "")}
                  fallback={<BotIcon className="size-4 text-muted-foreground" />}
                  className="size-5 shrink-0 mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{hit.label || hit.id}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {hit.providerName ? `${hit.providerName} · ` : ""}
                    {hit.id}
                  </span>
                  {(hit.contextWindow || hit.pricing || hit.reasoningEfforts.length > 0) && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        hit.contextWindow ? `${formatTokens(hit.contextWindow)} ctx` : "",
                        hit.pricing
                          ? `$${trimNum(hit.pricing.input)}/$${trimNum(hit.pricing.output)}`
                          : "",
                        hit.reasoningEfforts.length
                          ? `efforts: ${hit.reasoningEfforts.join(" · ")}`
                          : "",
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </span>
                  )}
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
          {state !== "ready" || results.length === 0 ? (
            <div className="px-2 py-2 text-xs text-pretty text-muted-foreground">
              {state === "loading" ? (
                "Searching…"
              ) : state === "failed" ? (
                <>
                  models.dev is unreachable right now.{" "}
                  <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </Button>
                </>
              ) : (
                "No match — try the model's real name rather than the id this provider serves it under."
              )}
            </div>
          ) : null}
        </ComboboxContent>
      </Combobox>
      {matched && (
        <span className="font-mono text-sm text-muted-foreground break-all">
          matched <span className="text-foreground font-medium">{matched}</span>
        </span>
      )}
    </div>
  )
}

/** The fetched candidates as a checkbox Picker, with everything a summary
    line wants in `subtitle`. */
function CandidatePicker({
  candidates,
  selected,
  onToggle,
}: {
  candidates: (ModelCandidate & { key: string })[]
  selected: string[]
  onToggle: (ids: string[]) => void
}) {
  const items = candidates.map((c) => ({ ...c, name: c.label || c.id }))
  return (
    <Picker
      items={items}
      selected={selected}
      onToggle={onToggle}
      icon={(c) => (
        <EntityIcon
          src={c.iconUrl ?? (c.providerId ? `https://models.dev/logos/${c.providerId}.svg` : "")}
          fallback={<BotIcon className="size-4 text-muted-foreground" />}
          className="size-5 shrink-0"
        />
      )}
      searchable
      searchPlaceholder="Search models…"
      searchText={(c) => `${c.name} ${c.id} ${c.providerName ?? ""}`}
      subtitle={(c) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-tight min-w-0">
          {c.providerName && <span className="font-sans text-muted-foreground">{c.providerName}</span>}
          <span className="break-all">{c.id}</span>
          {c.contextWindow ? <span>{formatTokens(c.contextWindow)} ctx</span> : null}
          {c.pricing ? (
            <span>
              ${trimNum(c.pricing.input)}/${trimNum(c.pricing.output)}
            </span>
          ) : null}
          {c.reasoningEfforts.length > 0 && <span>efforts: {c.reasoningEfforts.join(" · ")}</span>}
        </span>
      )}
      empty="Nothing to import — everything found is already in the list."
    />
  )
}

/* ── fetch dialog ──
   One source: the provider behind the profile's credentials, its own /models
   endpoint, enriched from models.dev server-side. Browsing models.dev's whole
   catalog used to be a second tab, and it was the wrong question — a profile
   can only run what its endpoint serves, and models.dev's role here is the
   metadata. There is nothing to type either: the fetch uses the same base URL
   and key the profile itself does (the form's current values, which is what
   the profile will be saved with), so opening the dialog IS the request.

   Two steps, because the two decisions are different: *which* of the served
   models to add, and then *what each one is* — the server's enrichment is a
   best guess by id, and a gateway's own ids ("oc/hy3-free") miss, so the
   second step shows what each pick came back with and lets it be matched by
   hand before anything lands in the form. Nothing is added until the last
   button; Back returns to the picks with the matches kept. */
function FetchModelsDialog({
  settings,
  profileId,
  baseUrl,
  apiKey,
  existingIds,
  onImport,
  onClose,
}: {
  settings: ServerSettings
  profileId: string
  baseUrl: string
  apiKey: string
  existingIds: string[]
  onImport: (rows: ModelRow[]) => void
  onClose: () => void
}) {
  const [step, setStep] = React.useState<"pick" | "fill">("pick")
  const [fetching, setFetching] = React.useState(true)
  const [fetched, setFetched] = React.useState<ModelCandidate[] | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  /* A failed fetch used to fall through to `setFetched([])`, which draws the
     picker's own "nothing to add" — a provider that served no new models and a
     request that never arrived, told apart by a toast behind the dialog. */
  const [fetchError, setFetchError] = React.useState<InlineError | null>(null)
  /* The rows being filled, keyed by candidate id. Built when Next is pressed
     and kept across Back so a match made by hand survives a changed pick. */
  const [drafts, setDrafts] = React.useState<Record<string, ModelRow>>({})

  const fetchModels = React.useCallback(async () => {
    setFetching(true)
    setFetched(null)
    setFetchError(null)
    try {
      const answer = await api<{ models: ModelCandidate[] }>(
        settings,
        `/api/profiles/${profileId}/fetch-models`,
        {
          method: "POST",
          // The form's own values: what a draft will save, and for a saved
          // profile an empty key means "use the stored one".
          body: JSON.stringify({
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
            ...(apiKey ? { apiKey } : {}),
          }),
        },
      )
      setFetched(answer.models)
      setSelected([])
    } catch (err) {
      setFetchError(captureError(err, "Couldn't fetch the provider's models"))
      setFetched([])
    } finally {
      setFetching(false)
    }
  }, [settings, profileId, baseUrl, apiKey])

  // Fetch on open. The credentials are captured when the dialog mounts, which
  // is when the button was pressed; "Fetch again" re-asks with whatever has
  // been typed since.
  React.useEffect(() => {
    void fetchModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Fresh candidates only; the provider may serve models this profile already lists.
  const candidates = (fetched ?? [])
    .filter((c) => c.id && !existingIds.includes(c.id))
    .map((c) => ({ ...c, key: c.id }))

  const picked = candidates.filter((c) => selected.includes(c.key))

  const next = () => {
    setDrafts((current) => {
      const kept: Record<string, ModelRow> = {}
      for (const c of picked) kept[c.id] = current[c.id] ?? candidateToRow(c)
      return kept
    })
    setStep("fill")
  }
  const patchDraft = (id: string, patch: Partial<ModelRow>) =>
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }))

  const importAll = () => {
    const rows = picked.map((c) => drafts[c.id]).filter(Boolean)
    onImport(rows)
    toast.success(`Imported ${rows.length} model${rows.length === 1 ? "" : "s"}`)
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent>
        {step === "pick" ? (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>Fetch models</ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="break-words">
                The live model list from <span className="font-mono text-sm break-all">{baseUrl.trim()}</span>. Pick the ones to add.
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            {fetching ? (
              <PickerSkeleton rows={5} />
            ) : fetchError ? (
              <ErrorNote error={fetchError} onRetry={() => void fetchModels()} retryLabel="Fetch again" />
            ) : (
              <CandidatePicker candidates={candidates} selected={selected} onToggle={setSelected} />
            )}
            <ResponsiveDialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={fetching}
                onClick={fetchModels}
              >
                Fetch again
              </Button>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" disabled={fetching || picked.length === 0} onClick={next}>
                Next{picked.length ? ` · ${picked.length}` : ""}
              </Button>
            </ResponsiveDialogFooter>
          </>
        ) : (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>Fill from models.dev</ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="break-words">
                What each pick was recognised as. Match any the provider serves under its own id
                to get the name, context window, pricing and efforts.
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <div className={cn("divide-y", INSET)}>
              {picked.map((c) => {
                const row = drafts[c.id]
                if (!row) return null
                const badges = summaryBadges(row)
                return (
                  <div key={c.id} className="space-y-2 p-2.5 @panel-sm:p-3 min-w-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <EntityIcon
                        src={row.iconUrl}
                        fallback={<BotIcon className="size-4 text-muted-foreground" />}
                        className="size-5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {row.label.trim() || row.id}
                        </span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">
                          {row.id}
                        </span>
                      </div>
                    </div>
                    {badges.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {badges.map((badge) => (
                          <Badge key={badge} variant="outline" className="font-normal text-muted-foreground">
                            {badge}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <ModelsDevMatch
                      row={row}
                      settings={settings}
                      onPatch={(patch) => patchDraft(c.id, patch)}
                    />
                  </div>
                )
              })}
            </div>
            <ResponsiveDialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep("pick")}>
                Back
              </Button>
              <Button type="button" onClick={importAll}>
                Import {picked.length} model{picked.length === 1 ? "" : "s"}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
