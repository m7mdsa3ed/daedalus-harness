import * as React from "react"
import { Download, Pencil, Plus, Star, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import { api, type ModelCandidate, type ModelsDevProvider, type ServerSettings } from "@/lib/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Field, Picker } from "./primitives"

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
  description: string
  pricingInput: string
  pricingOutput: string
  modalities: string
  devRef: string
}

let modelUid = 0
export const blankModelRow = (): ModelRow => ({
  uid: `model-${++modelUid}`,
  id: "",
  label: "",
  contextWindow: "",
  maxOutputTokens: "",
  efforts: "",
  description: "",
  pricingInput: "",
  pricingOutput: "",
  modalities: "",
  devRef: "",
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
  description: candidate.description ?? "",
  pricingInput: candidate.pricing ? String(candidate.pricing.input) : "",
  pricingOutput: candidate.pricing ? String(candidate.pricing.output) : "",
  modalities: (candidate.modalities ?? []).join(", "),
  devRef: candidate.devRef ?? "",
})

export const toModelRows = (models: {
  id: string
  label: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEfforts: string[]
  description?: string
  pricing?: { input: number; output: number }
  modalities?: string[]
  devRef?: string
}[]): ModelRow[] =>
  models.map((m) => ({
    uid: `model-${++modelUid}`,
    id: m.id,
    label: m.label && m.label !== m.id ? m.label : "",
    contextWindow: m.contextWindow ? String(m.contextWindow) : "",
    maxOutputTokens: m.maxOutputTokens ? String(m.maxOutputTokens) : "",
    efforts: m.reasoningEfforts.join(", "),
    description: m.description ?? "",
    pricingInput: m.pricing ? String(m.pricing.input) : "",
    pricingOutput: m.pricing ? String(m.pricing.output) : "",
    modalities: (m.modalities ?? []).join(", "),
    devRef: m.devRef ?? "",
  }))

export function rowsToModels(rows: ModelRow[]) {
  const models: {
    id: string
    label: string
    contextWindow?: number
    maxOutputTokens?: number
    reasoningEfforts: string[]
    description?: string
    pricing?: { input: number; output: number }
    modalities?: string[]
    devRef?: string
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
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
      ...(row.pricingInput.trim() &&
      row.pricingOutput.trim() &&
      pricingInput > 0 &&
      pricingOutput > 0
        ? { pricing: { input: pricingInput, output: pricingOutput } }
        : {}),
      ...(modalities.length ? { modalities } : {}),
      ...(row.devRef.trim() ? { devRef: row.devRef.trim() } : {}),
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
  onImport: (candidates: ModelCandidate[]) => void
}) {
  const [editingUid, setEditingUid] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)

  const patch = (uid: string, p: Partial<ModelRow>) => {
    // Editing the id invalidates the metadata's provenance: it described the
    // old id, and a stale devRef would survive an id it never matched.
    const row = rows.find((r) => r.uid === uid)
    if (p.id !== undefined && row && p.id !== row.id && p.devRef === undefined) p = { ...p, devRef: "" }
    onPatch(uid, p)
  }

  return (
    <Field
      label="Models"
      hint="What the provider behind this profile serves. A model with no efforts has no reasoning-effort setting."
    >
      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-pretty text-muted-foreground">
            No models — this profile lets the agent use its own catalog. Add or import models to
            override it.
          </p>
        ) : (
          <div className="divide-y rounded-lg border">
            {rows.map((row) => {
              const isDefault = row.id.trim() !== "" && row.id.trim() === defaultModel
              const badges = summaryBadges(row)
              return (
                <div key={row.uid}>
                  <div className="flex items-start gap-2 p-3">
                    <Button
                      type="button"
                      variant={isDefault ? "secondary" : "ghost"}
                      size="icon-lg"
                      className="shrink-0"
                      title={isDefault ? "This is the default model" : "Make default"}
                      onClick={() => onSetDefault(row.uid)}
                    >
                      <Star className={isDefault ? "fill-current" : undefined} />
                    </Button>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      title={row.description.trim() || row.id}
                      onClick={() => setEditingUid(editingUid === row.uid ? null : row.uid)}
                    >
                      <span className="block truncate text-sm font-medium">
                        {row.label.trim() || "Unnamed model"}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {row.id.trim() || "no id yet"}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        title={editingUid === row.uid ? "Collapse" : "Edit"}
                        onClick={() => setEditingUid(editingUid === row.uid ? null : row.uid)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-lg"
                        title="Remove model"
                        onClick={() => onRemove(row.uid)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {badges.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3 pb-3 pl-12">
                      {badges.map((badge) => (
                        <Badge key={badge} variant="outline" className="font-normal text-muted-foreground">
                          {badge}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {editingUid === row.uid && (
                    <ModelEditorFields row={row} settings={settings} onPatch={(p) => patch(row.uid, p)} />
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="lg" onClick={onAdd}>
            <Plus className="size-4" /> Add model
          </Button>
          <Button type="button" variant="outline" size="lg" onClick={() => setImporting(true)}>
            <Download className="size-4" /> Import models
          </Button>
        </div>
      </div>
      {importing && (
        <ModelImportPanel
          settings={settings}
          profileId={profileId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          existingIds={rows.map((r) => r.id.trim()).filter(Boolean)}
          onImport={(candidates) => {
            onImport(candidates)
            setImporting(false)
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </Field>
  )
}

/* ── expanded per-model editor ── */

function ModelEditorFields({
  row,
  settings,
  onPatch,
}: {
  row: ModelRow
  settings: ServerSettings
  onPatch: (patch: Partial<ModelRow>) => void
}) {
  return (
    <div className="space-y-3 border-t bg-muted/20 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Model id">
          <Input
            value={row.id}
            onChange={(e) => onPatch({ id: e.target.value })}
            placeholder="claude-opus-5"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Display name" hint="Empty = the id.">
          <Input
            value={row.label}
            onChange={(e) => onPatch({ label: e.target.value })}
            placeholder="Claude Opus 5"
            className="text-xs"
          />
        </Field>
        <Field label="Context window" hint="Tokens.">
          <Input
            type="number"
            value={row.contextWindow}
            onChange={(e) => onPatch({ contextWindow: e.target.value })}
            placeholder="200000"
            className="text-right font-mono text-xs"
          />
        </Field>
        <Field label="Max output tokens">
          <Input
            type="number"
            value={row.maxOutputTokens}
            onChange={(e) => onPatch({ maxOutputTokens: e.target.value })}
            placeholder="64000"
            className="text-right font-mono text-xs"
          />
        </Field>
        <Field label="Reasoning efforts" hint="Comma-separated; empty = no effort control.">
          <Input
            value={row.efforts}
            onChange={(e) => onPatch({ efforts: e.target.value })}
            placeholder="low, medium, high"
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Input modalities" hint="Comma-separated.">
          <Input
            value={row.modalities}
            onChange={(e) => onPatch({ modalities: e.target.value })}
            placeholder="text, image"
            className="font-mono text-xs"
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
            className="text-right font-mono text-xs"
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
            className="text-right font-mono text-xs"
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <Textarea
              rows={2}
              value={row.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              className="text-xs"
            />
          </Field>
        </div>
      </div>
      <ModelsDevMatch row={row} settings={settings} onPatch={onPatch} />
    </div>
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
      description: hit.description ?? "",
      pricingInput: hit.pricing ? String(hit.pricing.input) : "",
      pricingOutput: hit.pricing ? String(hit.pricing.output) : "",
      modalities: (hit.modalities ?? []).join(", "),
    }
    if (!row.label.trim() || row.label.trim() === row.id.trim())
      patch.label = label === hit.id ? "" : label
    onPatch(patch)
    setOpen(false)
  }

  const matched = row.devRef.trim()

  return (
    <div className="flex flex-wrap items-center gap-2">
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
        <ComboboxTrigger render={<Button type="button" variant="outline" size="sm" />}>
          {matched ? "Change models.dev match" : "Match on models.dev"}
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput showTrigger={false} placeholder="Search models.dev…" />
          <ComboboxList>
            {results.map((hit) => (
              <ComboboxItem key={`${hit.providerId ?? "?"}:${hit.id}`} value={hit}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{hit.label || hit.id}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {hit.providerName ? `${hit.providerName} · ` : ""}
                    {hit.id}
                  </span>
                  {(hit.contextWindow || hit.pricing || hit.reasoningEfforts.length > 0) && (
                    <span className="block truncate text-[11px] text-muted-foreground">
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
            <div className="px-3 py-3 text-center text-xs text-pretty text-muted-foreground">
              {state === "loading" ? (
                "Searching…"
              ) : state === "failed" ? (
                <>
                  models.dev is unreachable right now.{" "}
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Retry
                  </button>
                </>
              ) : (
                "No match — try the model's real name rather than the id this provider serves it under."
              )}
            </div>
          ) : null}
        </ComboboxContent>
      </Combobox>
      {matched && (
        <span className="font-mono text-xs text-muted-foreground">
          matched <span className="text-foreground">{matched}</span>
        </span>
      )}
    </div>
  )
}

/* ── import dialog ──
   Two sources, one dialog: the provider behind the profile's credentials
   (its own /models endpoint, enriched from models.dev server-side) and
   models.dev's catalog browsed directly. */

function ModelImportPanel({
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
  onImport: (candidates: ModelCandidate[]) => void
  onClose: () => void
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Import models</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
        <Tabs defaultValue="provider">
          <TabsList>
            <TabsTrigger value="provider">From provider</TabsTrigger>
            <TabsTrigger value="catalog">From models.dev</TabsTrigger>
          </TabsList>
          <TabsContent value="provider">
            <ProviderFetchTab
              settings={settings}
              profileId={profileId}
              baseUrl={baseUrl}
              apiKey={apiKey}
              existingIds={existingIds}
              onImport={onImport}
              onClose={onClose}
            />
          </TabsContent>
          <TabsContent value="catalog">
            <CatalogImportTab settings={settings} existingIds={existingIds} onImport={onImport} onClose={onClose} />
          </TabsContent>
        </Tabs>
    </section>
  )
}

/** Candidate list shared by both tabs: the checkbox Picker keyed by a
    composite key, with everything a summary line wants in `subtitle`. */
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
      subtitle={(c) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {c.providerName && <span className="font-sans text-muted-foreground/70">{c.providerName}</span>}
          <span>{c.id}</span>
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

/** The provider behind the profile's credentials: fetch its live /models list
    and pick from it. There is nothing to type here — the fetch uses the same
    base URL and key the profile itself does (the form's current values, which
    is what the profile will be saved with), and the server enriches every
    fetched id from models.dev before the list is shown. */
function ProviderFetchTab({
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
  onImport: (candidates: ModelCandidate[]) => void
  onClose: () => void
}) {
  const [fetching, setFetching] = React.useState(false)
  const [fetched, setFetched] = React.useState<ModelCandidate[] | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])

  const fetchModels = async () => {
    setFetching(true)
    setFetched(null)
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
      reportError(err, "Couldn't fetch the provider's models")
    } finally {
      setFetching(false)
    }
  }

  // Fresh candidates only; the provider may serve models this profile already lists.
  const candidates = (fetched ?? [])
    .filter((c) => c.id && !existingIds.includes(c.id))
    .map((c) => ({ ...c, key: c.id }))

  const importSelected = () => {
    const picked = candidates.filter((c) => selected.includes(c.key))
    onImport(picked)
    toast.success(`Imported ${picked.length} model${picked.length === 1 ? "" : "s"}`)
  }

  return (
    <div className="space-y-3 pt-2">
      <p className="text-xs text-pretty text-muted-foreground">
        {baseUrl.trim()
          ? `Fetches the live model list from ${baseUrl.trim()}, mapped against models.dev for names, context windows and pricing.`
          : "Fetches the live model list from this profile's provider. Add a base URL above first."}
      </p>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={fetching || !baseUrl.trim()}
          onClick={fetchModels}
        >
          {fetching ? "Fetching…" : "Fetch"}
        </Button>
      </div>
      {fetched !== null && (
        <>
          <CandidatePicker candidates={candidates} selected={selected} onToggle={setSelected} />
          <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={selected.length === 0} onClick={importSelected}>
              Import {selected.length || ""} model{selected.length === 1 ? "" : "s"}
            </Button>
          </footer>
        </>
      )}
    </div>
  )
}

/** models.dev's catalog, searched server-side. Provider filter + debounced
    query; every hit arrives already enriched, so importing is a plain copy. */
function CatalogImportTab({
  settings,
  existingIds,
  onImport,
  onClose,
}: {
  settings: ServerSettings
  existingIds: string[]
  onImport: (candidates: ModelCandidate[]) => void
  onClose: () => void
}) {
  const [providers, setProviders] = React.useState<ModelsDevProvider[] | null>(null)
  const [provider, setProvider] = React.useState("all")
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<ModelCandidate[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<string[]>([])

  React.useEffect(() => {
    let cancelled = false
    api<{ providers: ModelsDevProvider[] }>(settings, "/api/models-dev/providers")
      .then((r) => !cancelled && setProviders(r.providers))
      .catch((err) => {
        reportError(err, "Couldn't load models.dev's providers")
        if (!cancelled) setProviders([])
      })
    return () => {
      cancelled = true
    }
  }, [settings])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: "50" })
      if (query.trim()) params.set("q", query.trim())
      if (provider !== "all") params.set("provider", provider)
      api<{ models: ModelCandidate[] }>(settings, `/api/models-dev/search?${params}`)
        .then((r) => {
          if (cancelled) return
          setResults(r.models)
          setSelected([])
        })
        .catch((err) => {
          if (cancelled) return
          reportError(err, "Couldn't search models.dev")
          setResults([])
        })
        .finally(() => !cancelled && setLoading(false))
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [settings, query, provider])

  // Composite keys (the same model id can exist under several providers), and
  // only fresh candidates — a hit this profile already lists is noise.
  const candidates = (results ?? [])
    .filter((c) => c.id && !existingIds.includes(c.id))
    .map((c) => ({ ...c, key: `${c.providerId}:${c.id}` }))

  const importSelected = () => {
    const picked = candidates
      .filter((c) => selected.includes(c.key))
      .map(({ key: _key, ...candidate }) => candidate)
    onImport(picked)
    toast.success(`Imported ${picked.length} model${picked.length === 1 ? "" : "s"}`)
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
        <Select value={provider} onValueChange={(value) => setProvider(value ?? "all")}>
          <SelectTrigger className="w-full">
            <SelectValue>
              {provider === "all" ? "All providers" : providers?.find((p) => p.id === provider)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {(providers ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models.dev…"
        />
      </div>
      {providers !== null && providers.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-pretty text-muted-foreground">
          models.dev is unreachable right now — try again later.
        </p>
      ) : results === null || loading ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Searching…
        </p>
      ) : (
        <CandidatePicker
          candidates={candidates}
          selected={selected}
          onToggle={setSelected}
        />
      )}
      <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={selected.length === 0} onClick={importSelected}>
          Import {selected.length || ""} model{selected.length === 1 ? "" : "s"}
        </Button>
      </footer>
    </div>
  )
}
