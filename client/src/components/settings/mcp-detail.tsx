/* ── What an MCP server offers ──
   The library row's own page (`/settings/mcp/:id/tools`): the tools, prompts
   and resources the server puts in front of an agent — what each one takes,
   what it answers — read from the stored listing the row already draws its
   counts from.

   It is a *reading*, and deliberately nothing more. Running an entry is not
   here: a tool call is the agent's, behind its permission gate, and prompting,
   reading or completing from a settings screen was the playground, which is
   gone. What is left is the contract — a rail of what the server offers beside
   the fields of the one picked, with the raw schema a fold below.

   The sections are one component (`EntryDetail`) rather than four, because the
   only thing that differs between a tool, a prompt, a resource and a template
   is the shape of its contract; the tabs and the field list are the same. */
import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeftIcon, SearchCheckIcon, SearchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/notice"
import { Empty } from "@/components/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useMcpCatalog, useMcpServers, useProjects } from "@/lib/queries/catalog"
import { mcpCatalogKey } from "@/lib/queries/keys"
import { settingsPath } from "@/lib/router"
import { api, mcpSubtitle, type McpCheckEntry, type McpCheckResult } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { FormPageHeader, Group } from "./primitives"
import { useSettingsPage } from "./layout"

export function McpDetailPage() {
  const { entryId = "" } = useParams()
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const servers = useMcpServers()
  const server = servers.find((s) => s.id === entryId)
  const projects = useProjects()
  /* A thread-scoped built-in has no server to connect to without a thread, so
     this page never reads one — it explains, like the row it was opened from. */
  const scoped = server?.type === "builtin" && !!server.threadScoped
  const query = useMcpCatalog(entryId, !scoped)
  const { busy, run } = useAsyncAction({ toast: true })

  /* Which project a listing is read against. It matters only for the harness's
     own servers — a builtin's env carries the calling thread's project, and
     there is no thread behind this page — so the picker is drawn only for
     those; for everything else the server is the same server in every
     directory. */
  const [projectId, setProjectId] = React.useState("")
  const project = projectId || projects[0]?.id || ""

  const check = () =>
    void run(`Couldn't check ${server?.name ?? "this server"}`, async () => {
      qc.setQueryData(
        mcpCatalogKey(settings, entryId),
        await api<McpCheckResult>(settings, `/api/mcp-servers/${entryId}/check?project=${project}`, {
          method: "POST",
        })
      )
    })

  // A row still loading is an empty list, not a missing server.
  if (!server) return servers.length === 0 ? null : <Navigate to={settingsPath("mcp")} replace />

  /* Reached by a direct URL, normally: nothing links here for a thread-scoped
     built-in. There is nothing to list, so the page says why rather than
     offering a Check that cannot connect. */
  if (scoped) {
    return (
      <div className="mx-auto w-full max-w-7xl">
        <FormPageHeader
          title={server.name}
          description={mcpSubtitle(server)}
          onBack={() => void navigate(settingsPath("mcp"))}
        />
        <Notice tone="info" title="Listed on the thread that links it">
          This built-in is resolved at spawn, on the calling thread — its connection is that thread's own,
          so there is no server here to connect to. Link it to a profile or a thread to give an agent its
          tools, and read what it offers from that thread.
        </Notice>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl">
      <FormPageHeader
        title={server.name}
        description={mcpSubtitle(server)}
        onBack={() => void navigate(settingsPath("mcp"))}
      />
      {query.error && (
        <Notice tone="error" title="Couldn't read what this server offers">
          {query.error.message}
        </Notice>
      )}
      <Offering result={query.data?.deferred ? null : query.data ?? null}>
        {server.type === "builtin" && projects.length > 1 && (
          <Select value={project} onValueChange={(value) => setProjectId(value ?? "")}>
            <SelectTrigger size="sm" className="w-56" title="Which project a listing is read against">
              <SelectValue>{projects.find((p) => p.id === project)?.name ?? "Project"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy || query.isFetching}
          onClick={check}
          title="Connect now and list what this server offers"
        >
          <SearchCheckIcon className="size-4" /> {busy || query.isFetching ? "Checking…" : "Check"}
        </Button>
      </Offering>
    </div>
  )
}

/**
 * A connected server's surface: what it called itself and declared, its
 * instructions, and every tool, prompt, resource and template as a row in the
 * rail. `children` are the page's own controls, drawn at the end of the badge
 * row.
 */
function Offering({ result, children }: { result: McpCheckResult | null; children?: React.ReactNode }) {
  const sections: { kind: EntryKind; label: string; entries: McpCheckEntry[] }[] = [
    { kind: "tool", label: "Tools", entries: result?.tools ?? [] },
    { kind: "prompt", label: "Prompts", entries: result?.prompts ?? [] },
    { kind: "resource", label: "Resources", entries: result?.resources ?? [] },
    { kind: "template", label: "Resource templates", entries: result?.resourceTemplates ?? [] },
  ]
  /* The filter narrows the rail and never the entry in front of you — it stays
     open while the collection is searched, as Postman's does. `chosen` is the
     *explicit* pick, which is what lets a narrow panel tell "the reader opened
     this" from "this is just the first row". */
  const [query, setQuery] = React.useState("")
  const [chosen, setChosen] = React.useState<string | null>(null)
  const needle = query.trim().toLowerCase()

  /* Every entry the server offers, in the order the sections run. The rail
     lists these; a filter narrows what is *listed* and a selection is resolved
     against the whole set, so an entry you have open never vanishes. */
  const rows = sections.flatMap(({ kind, label, entries }) => entries.map((entry) => ({ kind, label, entry })))
  const shown = needle ? rows.filter((row) => entryMatches(row.entry, needle)) : rows
  const groups = sections.map(({ kind, label }) => ({ kind, label, shown: shown.filter((row) => row.kind === kind) }))
  const current = rows.find((row) => rowKey(row) === chosen) ?? rows[0] ?? null

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-3 py-2 shadow-sm @panel-sm:px-4">
        {result ? (
          <>
            <span className="text-sm font-medium">{result.serverInfo?.name ?? "Connected"}</span>
            {result.serverInfo?.version && (
              <Badge variant="outline" className="font-normal">
                {result.serverInfo.version}
              </Badge>
            )}
            {/* What the server declared it can do — the protocol's own words,
                so "no prompts" and "prompts it has not listed yet" read apart. */}
            {Object.keys(result.capabilities ?? {})
              .filter((key) => key !== "experimental")
              .map((key) => (
                <Badge key={key} variant="secondary" className="font-normal">
                  {key}
                </Badge>
              ))}
            {result.ok && (
              <span className="text-xs text-muted-foreground tabular-nums">listed in {result.ms}ms</span>
            )}
          </>
        ) : (
          /* `result` is null both while the listing is being read and when the
             server defers its first connection until Check, so the line says
             neither — it just says there is nothing to show yet. */
          <span className="text-sm text-muted-foreground">Not listed yet.</span>
        )}
        {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
      </div>

      {result && !result.ok && (
        /* A stdio child's stderr rides the error, so it is a well to select
           from rather than a headline. */
        <Notice tone="error" title="Didn't connect">
          <pre className="font-mono text-xs whitespace-pre-wrap">
            {result.error ?? "The server refused the connection."}
          </pre>
        </Notice>
      )}

      {result?.ok && (
        <>
          {/* The text a client puts in front of its model — the Daedalus agent
              does, in its system prompt — so it is worth reading here, above
              the two panes rather than in one of them. */}
          {result.instructions && (
            <Group label="Instructions">
              <p className="py-3 text-sm whitespace-pre-wrap">{result.instructions}</p>
            </Group>
          )}
          <div className="mt-3 grid items-start gap-3 @panel-lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <Rail
              groups={groups}
              total={rows.length}
              matched={shown.length}
              query={query}
              onQuery={setQuery}
              currentKey={current ? rowKey(current) : null}
              onPick={setChosen}
              /* A narrow panel is the rail *or* the entry, never both: the pick
                 is what swaps them and the entry's Back button is the way
                 back. */
              className={chosen ? "hidden @panel-lg:block" : undefined}
            />
            <div className={chosen ? "min-w-0" : "hidden min-w-0 @panel-lg:block"}>
              {current ? (
                <EntryDetail key={rowKey(current)} kind={current.kind} entry={current.entry} onBack={() => setChosen(null)} />
              ) : (
                <Empty size="lg">{NOTHING_TO_RUN}</Empty>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}

/** The rail: what the server offers, grouped the way the sections are, under
    the one filter that narrows it. Postman's collection tree, one level deep —
    a list of destinations, and the thing you pick stays picked while you search
    past it. */
function Rail({
  groups,
  total,
  matched,
  query,
  onQuery,
  currentKey,
  onPick,
  className,
}: {
  groups: { kind: EntryKind; label: string; shown: { kind: EntryKind; label: string; entry: McpCheckEntry }[] }[]
  total: number
  matched: number
  query: string
  onQuery: (value: string) => void
  currentKey: string | null
  onPick: (key: string) => void
  className?: string
}) {
  return (
    <nav
      aria-label="What this server offers"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm",
        /* Below `@panel-lg` the rail *is* the page, so it neither sticks nor
           caps its own height — the frame scrolls it. At `@panel-lg` it holds
           its place beside the entry and scrolls inside itself. */
        "@panel-lg:sticky @panel-lg:top-[var(--app-header-h)]",
        className
      )}
    >
      <div className="border-b p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Filter by name or description…"
            aria-label="Filter what this server offers"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 @panel-lg:max-h-[calc(var(--panel-h,100svh)-var(--app-header-h)-8rem)]">
        {groups.map(({ kind, label, shown }) =>
          shown.length === 0 ? null : (
            <div key={kind} className="mb-1.5 last:mb-0">
              <p className="px-2 py-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                {label} · {shown.length}
              </p>
              {shown.map((row) => {
                const key = rowKey(row)
                const active = key === currentKey
                return (
                  <button
                    key={key}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onPick(key)}
                    className={cn(
                      "block w-full rounded-md px-2 py-1.5 text-left",
                      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                    )}
                  >
                    <span className="block font-mono text-xs break-all">{row.entry.name}</span>
                    {row.entry.description && (
                      <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                        {row.entry.description}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        )}
        {matched === 0 && (
          <p className="p-2 text-xs text-muted-foreground">
            {total === 0 ? NOTHING_TO_RUN : `Nothing matches “${query.trim()}”.`}
          </p>
        )}
      </div>
    </nav>
  )
}

/** The page's four sections: the three things a server offers, plus templates,
    whose URI is the thing a reader fills in. */
type EntryKind = "tool" | "prompt" | "resource" | "template"

/** What one entry is called in the header. The protocol's own words,
    lowercased — a prompt is a prompt in every runtime's vocabulary. */
const KIND_LABEL: Record<EntryKind, string> = {
  tool: "Tool",
  prompt: "Prompt",
  resource: "Resource",
  template: "Template",
}

/** What identifies a row in the rail: its kind *and* its name, because a tool
    and a prompt may share one ("search" is both, often enough). */
const rowKey = (row: { kind: EntryKind; entry: McpCheckEntry }) => `${row.kind}:${row.entry.name}`

/** Said by the rail when the server offers nothing at all, and by the pane
    beside it while nothing has been picked. */
const NOTHING_TO_RUN = "This server advertises nothing to run."

/**
 * One tool, prompt, resource or template, drawn as its contract: a bar naming
 * the entry and its type, then the fields it takes and the schema they are
 * typed against. Nothing here runs — this is the reading a person opens the
 * page to make, of what a thread linking this server would be handed.
 */
function EntryDetail({
  kind,
  entry,
  onBack,
}: {
  kind: EntryKind
  entry: McpCheckEntry
  /** Back to the rail — drawn only where the panel is too narrow for both. */
  onBack: () => void
}) {
  const inputs =
    kind === "prompt"
      ? promptFields(entry)
      : kind === "template"
        ? templateFields(entry.uri ?? entry.name)
        : schemaFields(entry.inputSchema)
  const outputs = schemaFields(entry.outputSchema)
  /* The entry's own shape picks its tabs: a resource has no payload to type
     (its URI *is* the request), so it gets the one tab that says what will be
     read; only a tool declares an output schema. `kind` is fixed for the life
     of this component — it is part of the row's key. */
  const tabs = [
    { id: "input", label: kind === "resource" ? "Reads" : "Input" },
    ...(kind === "tool" ? [{ id: "output", label: "Output" }] : []),
  ]
  const [tab, setTab] = React.useState(tabs[0].id)

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 @panel-lg:hidden"
          aria-label="Back to what this server offers"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <Badge variant="secondary" className="font-normal">
          {KIND_LABEL[kind]}
        </Badge>
        {/* A resource *is* its URI and a template is its fillable one, so the
            bar says the thing that will be requested rather than the label. */}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={entry.uri ?? entry.name}>
          {entry.uri ?? entry.name}
        </span>
        {entry.mimeType && (
          <Badge variant="outline" className="font-normal">
            {entry.mimeType}
          </Badge>
        )}
      </div>

      {/* What the entry is for, in the server's own words. */}
      {entry.description && (
        <p className="border-b px-3 py-2 text-xs/relaxed text-muted-foreground">{entry.description}</p>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
        <TabsList variant="line" className="w-full justify-start border-b px-2">
          {tabs.map((tabItem) => (
            <TabsTrigger key={tabItem.id} value={tabItem.id} className="flex-none text-xs">
              {tabItem.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="input" className="p-3">
          <Fields
            label={kind === "resource" ? "Reads" : "Input"}
            fields={inputs}
            schema={entry.inputSchema}
            empty={kind === "resource" ? (entry.uri ?? entry.name) : "Takes no arguments."}
          />
        </TabsContent>

        {kind === "tool" && (
          <TabsContent value="output" className="p-3">
            <Fields
              label="Output"
              fields={outputs}
              schema={entry.outputSchema}
              /* No `outputSchema` is not "answers nothing" — it is the default
                 MCP shape, and saying so is the difference between a tool nobody
                 can read and one whose answer simply is not typed. */
              empty="No output schema — answers content blocks (text, images or embedded resources)."
            />
          </TabsContent>
        )}
      </Tabs>
    </article>
  )
}

interface Field {
  name: string
  type: string
  required: boolean
  description?: string
}

/** One side of the contract, in words, with the schema itself one fold below.
    The list is what a person reads; the raw schema is what they check when the
    list is not enough. */
function Fields({
  label,
  fields,
  schema,
  empty,
}: {
  label: string
  fields: Field[]
  schema?: unknown
  empty: string
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {fields.map((field) => (
            <li key={field.name} className="text-xs">
              <span className="font-mono">{field.name}</span>
              <span className="ml-1.5 text-muted-foreground">{field.type}</span>
              {field.required && <span className="ml-1 text-destructive" title="required">*</span>}
              {field.description && (
                <span className="block text-muted-foreground">{field.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {schema != null && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground">Schema</summary>
          <Pane text={JSON.stringify(schema, null, 2)} />
        </details>
      )}
    </div>
  )
}

/** The schema pane: preformatted, scrolled, with the same Copy every drawn
    error and result in this app carries. */
function Pane({ text, className }: { text: string; className?: string }) {
  return (
    <div className="relative">
      <pre className={cn("overflow-auto rounded-md bg-muted/50 p-2.5 pr-9 font-mono text-xs", className ?? "max-h-80")}>
        {text}
      </pre>
      <CopyButton text={text} variant="ghost" size="icon" className="absolute top-1 right-1" />
    </div>
  )
}

/** Whether the filter word is in what an entry is *called* — its name, its
    description and, for a resource, the URI, which for a resource is the name. */
const entryMatches = (entry: McpCheckEntry, needle: string) =>
  `${entry.name} ${entry.description ?? ""} ${entry.uri ?? ""}`.toLowerCase().includes(needle)

/** A JSON Schema object read as the field list it describes. Anything that is
    not an object of properties — a `oneOf`, a bare string — has no field list,
    and the schema fold beside it is what says so. */
function schemaFields(schema: unknown): Field[] {
  const obj = schema as { properties?: Record<string, SchemaProp>; required?: unknown } | null
  const props = obj?.properties
  if (!props || typeof props !== "object") return []
  const required = new Set(Array.isArray(obj?.required) ? (obj.required as string[]) : [])
  return Object.entries(props).map(([name, prop]) => ({
    name,
    type: typeName(prop),
    required: required.has(name),
    description: prop?.description,
  }))
}

/** A prompt declares its arguments directly, and they are strings by the
    spec — the same three columns, from a different place. */
function promptFields(entry: McpCheckEntry): Field[] {
  return (entry.arguments ?? []).map((arg) => ({
    name: arg.name,
    type: "string",
    required: !!arg.required,
    description: arg.description,
  }))
}

interface SchemaProp {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  items?: SchemaProp
  anyOf?: SchemaProp[]
  oneOf?: SchemaProp[]
}

/** What to call one property's type in a list a person is scanning. An `enum`
    is named by its values, because "string" tells the reader nothing they
    could not have guessed and the four allowed words are the whole point. */
function typeName(prop: SchemaProp | undefined): string {
  if (!prop) return "any"
  if (prop.enum) return prop.enum.map((v) => JSON.stringify(v)).join(" | ")
  const union = prop.anyOf ?? prop.oneOf
  if (union) return union.map(typeName).join(" | ")
  const type = Array.isArray(prop.type) ? prop.type.join(" | ") : prop.type
  if (type === "array") return `${typeName(prop.items)}[]`
  return type ?? "any"
}

/** A template's variables — `{name}`, `{+path}`, `{?q,page}` — as the field
    list its URI is typed against. */
function templateFields(template: string): Field[] {
  const names = new Set<string>()
  for (const [, expr] of template.matchAll(/\{([^}]+)\}/g)) {
    for (const name of expr.replace(/^[+#./;?&]/, "").split(",")) names.add(name.replace(/[*:].*$/, ""))
  }
  return [...names].map((name) => ({ name, type: "string", required: true }))
}
