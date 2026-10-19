import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useTableFilter } from "@/lib/use-table-filter"
import {
  DataTable,
  TitleCell,
  type DataTableColumnMeta,
  type DataTableMobile,
  type TableAction,
} from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { useConfirm } from "@/components/confirm-dialog"
import { api, type ModelPrompt, type ServerSettings } from "@/lib/settings"
import { reportError } from "@/lib/errors"
import { useInvalidateCatalog, useModelPrompts } from "@/lib/queries/catalog"
import {
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  INSET,
  PageForm,
  PageHeader,
  StatStrip,
  StatusBadge,
} from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { saveLibraryEntry } from "./library"
import { useAsyncAction } from "@/hooks/use-async-action"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { cn } from "@/lib/utils"

/** What a pattern reaches, in words: no wildcard is one model, a bare `*` all of them. */
function scopeOf(match: string): { label: string; detail: string } {
  const m = match.trim()
  if (!m) return { label: "Nothing yet", detail: "Type a model id or a glob." }
  if (m === "*") return { label: "Every model", detail: "A bare * matches any model id." }
  if (m.includes("*") || m.includes("?")) return { label: "A family", detail: "Every model id the glob matches." }
  return { label: "One model", detail: "Exactly this id, case-insensitively." }
}

/** The prompt on one line, for a cell that truncates. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** Lines added and removed going from `before` to `after` — a multiset
    difference, not an LCS: it answers "how far from the saved text", which is
    all the indicator says. */
function lineDelta(before: string, after: string) {
  const counts = new Map<string, number>()
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split("\n")) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added++
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return { added, removed }
}

/**
 * Model prompts: instruction text assigned to a model by id or glob pattern.
 *
 * One table, in the order the runtime reads the rules: the pattern (the title,
 * in mono), the text it adds, what it reaches and whether it is on. A row opens
 * its edit page. There is no Import on purpose — no agent ships a model
 * prompt in its own config: this is the harness's concept, delivered to the
 * runtime through `{modelPromptsFile}`. The built-in family calibrations in the
 * runtime are the auto-detect half; these rows are the assignment half — "this
 * text, for that model" — and win over the built-ins whenever one matches.
 */
export function ModelPromptsPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("model-prompts")
  const prompts = useModelPrompts()
  const invalidate = useInvalidateCatalog()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const rows = React.useMemo(
    () => [...prompts].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [prompts]
  )
  const f = useTableFilter(rows, {
    text: (item) => `${item.name}\n${item.match}\n${item.prompt}`,
    placeholder: "Search patterns, names, text...",
    fields: [
      { id: "state", label: "State", of: (item) => (item.enabled ? "On" : "Off") },
      { id: "origin", label: "Origin", of: (item) => (item.seededVersion > 0 ? "Built-in" : "Yours") },
    ],
  })
  const enabled = rows.filter((item) => item.enabled).length
  const families = rows.filter((item) => /[*?]/.test(item.match)).length

  const edit = React.useCallback(
    (item?: ModelPrompt) => void navigate(settingsFormPath(meta.id, item?.id)),
    [navigate, meta.id]
  )
  const remove = async (item: ModelPrompt) => {
    if (
      !(await confirm({
        title: `Delete "${item.name}"?`,
        description:
          "The model prompt is removed from the library and unlinked from every profile and thread that used it. Threads already running keep it until they are restarted.",
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    try {
      await api(settings, `/api/model-prompts/${item.id}`, { method: "DELETE" })
      await invalidate("model-prompts")
    } catch (err) {
      reportError(err, "Couldn't delete the model prompt")
    }
  }
  // The actions memo must not rebuild when `confirm` or `settings` change identity.
  const removeRef = React.useRef(remove)
  removeRef.current = remove

  const columns = React.useMemo<ColumnDef<ModelPrompt, unknown>[]>(
    () => [
      {
        id: "pattern",
        header: "Pattern",
        cell: ({ row }) => (
          <TitleCell
            title={<code className="font-mono text-[13px]">{row.original.match}</code>}
            subtitle={row.original.name}
          />
        ),
        meta: { title: true, className: "min-w-52" } satisfies DataTableColumnMeta,
      },
      {
        id: "prompt",
        header: "Prompt",
        cell: ({ row }) => (
          <span className="block max-w-[48ch] truncate text-muted-foreground">{oneLine(row.original.prompt)}</span>
        ),
        meta: { className: "hidden min-w-64 @panel-md:table-cell" } satisfies DataTableColumnMeta,
      },
      {
        id: "applies",
        header: "Applies to",
        cell: ({ row }) => <span className="whitespace-nowrap">{scopeOf(row.original.match).label}</span>,
        meta: { className: "hidden @panel-sm:table-cell" } satisfies DataTableColumnMeta,
      },
      {
        id: "order",
        header: "Order",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{row.original.sortOrder}</span>
        ),
        meta: { align: "end", className: "hidden @panel-lg:table-cell" } satisfies DataTableColumnMeta,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusBadge tone={row.original.enabled ? "ok" : "neutral"}>{row.original.enabled ? "On" : "Off"}</StatusBadge>
        ),
        meta: { align: "end" } satisfies DataTableColumnMeta,
      },
    ],
    []
  )

  const tableActions = React.useMemo<TableAction<ModelPrompt>[]>(
    () => [
      { id: "edit", label: "Edit", icon: <Pencil className="size-4" />, onClick: (item) => edit(item), position: "left" },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 className="size-4" />,
        tone: "danger",
        onClick: (item) => void removeRef.current(item),
      },
    ],
    [edit]
  )

  const onRowClick = edit

  const mobile = React.useMemo<DataTableMobile<ModelPrompt>>(
    () => ({
      renderRow: (item) => (
        <div className="min-w-0 py-0.5">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <meta.icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 truncate font-mono text-[13px] font-medium">{item.match}</code>
                {!item.enabled && <StatusBadge>Off</StatusBadge>}
              </div>
              <div className="truncate text-xs text-muted-foreground">{item.name}</div>
              <div className="mt-1 line-clamp-2 text-xs break-words text-muted-foreground">{oneLine(item.prompt)}</div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                <span>{scopeOf(item.match).label}</span>
                <span>Order {item.sortOrder}</span>
              </div>
            </div>
          </div>
        </div>
      ),
    }),
    [meta.icon]
  )

  const newButton = (
    <Button className="h-11 @panel-sm:h-9" onClick={() => edit()}>
      <Plus className="size-4" /> New model prompt
    </Button>
  )

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      {rows.length > 0 && (
        <StatStrip
          stats={[
            { label: "Rules", value: rows.length, hint: "Read in order, ties by name" },
            { label: "On", value: enabled, hint: enabled === rows.length ? "All matching" : `${rows.length - enabled} off`, tone: enabled ? "ok" : "default" },
            { label: "Families", value: families, hint: "Globs, not exact ids" },
          ]}
        />
      )}
      <DataTable
        columns={columns}
        data={f.rows}
        getRowId={(item) => item.id}
        pageSize={25}
        mark={() => <meta.icon />}
        actions={tableActions}
        onRowClick={onRowClick}
        mobile={mobile}
        filtering={f.filtering}
        emptyIcon={<meta.icon />}
        emptyMessage={f.narrowed ? "No model prompts match that search." : "No model prompts yet."}
        emptyAction={f.narrowed ? undefined : newButton}
      />
    </>
  )
}

export function ModelPromptFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const prompts = useModelPrompts()
  const invalidate = useInvalidateCatalog()
  const prompt = entryId === "new" ? null : prompts.find((item) => item.id === entryId)
  if (entryId !== "new" && !prompt) return <Navigate to={settingsPath("model-prompts")} replace />
  return (
    <ModelPromptForm
      prompt={prompt ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await invalidate("model-prompts")
        void navigate(settingsPath("model-prompts"))
      }}
    />
  )
}

function ModelPromptForm({
  prompt,
  settings,
  onDone,
}: {
  prompt: ModelPrompt | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: prompt?.name ?? "",
    match: prompt?.match ?? "",
    prompt: prompt?.prompt ?? "",
    enabled: prompt?.enabled ?? true,
    sortOrder: String(prompt?.sortOrder ?? 0),
  }))
  const { busy, error: saveError, run } = useAsyncAction()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  // The indicator measures against what is saved; a new rule is measured against nothing.
  const saved = prompt?.prompt ?? ""
  const changed = form.prompt !== saved
  const delta = React.useMemo(() => lineDelta(saved, form.prompt), [saved, form.prompt])
  const scope = scopeOf(form.match)

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void run("Couldn't save the model prompt", async () => {
      await saveLibraryEntry(settings, "/api/model-prompts", prompt?.id, {
        name: form.name,
        match: form.match,
        prompt: form.prompt,
        enabled: form.enabled,
        sortOrder: Number(form.sortOrder) || 0,
      })
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={prompt ? `Edit ${prompt.name}` : "New model prompt"}
        description="Instruction text assigned to a model by id or pattern. A row whose match is a glob wins over the runtime's built-in family calibrations. The file is re-read every turn, so a live model change swaps the guidance with no respawn."
        onBack={() => onDone(false)}
      />
      <PageForm
        onSubmit={save}
        aiBuilder={{
          title: "model prompt",
          value: form,
          onApply: (value) => setForm((current) => ({ ...current, ...value })),
          schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Human-readable name for these model-specific instructions.", examples: ["Qwen concise"] },
              match: { type: "string", description: "Case-insensitive glob or exact model id that selects this prompt.", examples: ["qwen*", "gpt-4.1"] },
              prompt: { type: "string", description: "Short tuning instructions appended to the runtime prompt; do not replace base instructions.", examples: ["Prefer concise answers. State assumptions and verify behavior with tests when appropriate."] },
              enabled: { type: "boolean", description: "Whether the rule is active.", examples: [true] },
              sortOrder: { type: "string", description: "Numeric ordering value; ties break by name.", examples: ["0"] },
            },
            required: ["name", "match", "prompt", "enabled", "sortOrder"],
            additionalProperties: false,
          },
        }}
      >
        <FormShell
          sections={[
            { id: "rule", label: "Rule" },
            { id: "instructions", label: "Instructions" },
            { id: "behaviour", label: "Behaviour" },
          ]}
        >
          <FormSection id="rule" label="Rule" hint="Which models it reaches.">
            <div className="grid gap-4 @panel-md:grid-cols-2">
              <Field label="Name" hint="What this prompt is called in the list.">
                <Input
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="Qwen strict"
                  required
                />
              </Field>
              <Field
                label="Pattern"
                hint="A glob over the model id. No wildcards = exact id match. Use * for a family — e.g. qwen*, gemini-2.5*, deepseek*. Case-insensitive."
              >
                <Input
                  value={form.match}
                  onChange={(e) => set({ match: e.target.value })}
                  placeholder="qwen*"
                  className="font-mono text-xs"
                  required
                />
              </Field>
            </div>
            <div className={cn(INSET, "flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs")}>
              <span className="text-muted-foreground">Applies to</span>
              <span className="font-medium">{scope.label}</span>
              <span className="text-muted-foreground">{scope.detail}</span>
            </div>
          </FormSection>
          <FormSection
            id="instructions"
            label="Instructions"
            hint="Appended as a layer of the agent's system prompt, ahead of the project files. Keep it short — a few bullets about how to drive this engine. Avoid contradicting the base prompt; these lines tune it, not replace it."
            action={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusBadge tone={changed ? "info" : "neutral"} dot={false}>
                  {!changed
                    ? prompt
                      ? "Unchanged"
                      : "Empty"
                    : prompt
                      ? `+${delta.added} / −${delta.removed} lines`
                      : `${delta.added} lines`}
                </StatusBadge>
                {changed && prompt && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="pointer-coarse:h-11"
                    onClick={() => set({ prompt: saved })}
                  >
                    <RotateCcw className="size-3.5" /> Reset
                  </Button>
                )}
              </div>
            }
          >
            <Field label="Prompt">
              <Textarea
                value={form.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                rows={18}
                className="min-h-72 resize-y font-mono text-xs/relaxed @panel-md:min-h-[26rem]"
                required
              />
              <p className="text-right text-[11px] text-muted-foreground tabular-nums">
                {form.prompt ? form.prompt.split("\n").length : 0} lines · {form.prompt.length} chars
              </p>
            </Field>
          </FormSection>
          <FormSection id="behaviour" label="Behaviour" hint="Whether it matches, and where it sits in the list.">
            <Field
              label="Enabled"
              hint="Off keeps the row managed but stops it matching. The runtime's built-in family calibration stands in."
            >
              {/* `id`/`htmlFor` rather than a wrapping <label>: Base UI's Checkbox
                  renders a button, which a wrapping label does not toggle. */}
              <div className={cn(INSET, "flex items-center gap-2 px-3 py-2 pointer-coarse:min-h-11")}>
                <Checkbox
                  id="model-prompt-enabled"
                  checked={form.enabled}
                  onCheckedChange={(enabled) => set({ enabled })}
                />
                <Label htmlFor="model-prompt-enabled" className="flex-1 text-sm font-normal">
                  Enabled
                </Label>
              </div>
            </Field>
            <Field label="Order" hint="Where it sits in the list. Ties break by name.">
              <Input
                type="number"
                step={10}
                value={form.sortOrder}
                onChange={(e) => set({ sortOrder: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </FormSection>
        </FormShell>
        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
