/* ── What an MCP server offers ──
   The library row's own page (`/settings/mcp/:id/tools`): the tools, prompts
   and resources the server puts in front of an agent — what each one takes,
   what it answers — read from the stored listing the row already draws its
   counts from.

   It is a *reading*, and deliberately nothing more. Running an entry is not
   here: a tool call is the agent's, behind its permission gate, and prompting,
   reading or completing from a settings screen was the playground, which is
   gone. What is left is the contract.

   ── The layout ──
   A summary of the server on top, then a TabBar (Tools | Prompts | Resources)
   over one table of that kind's entries (searchable). A row opens the
   contract of the entry — its input and, for a tool, its output side by
   side — on a page of its own (`McpEntryPage`, `/settings/mcp/:id/tools/:key`).
   Resources and templates share a tab (a template is a resource whose URI is
   the thing a reader fills in); the table's Kind column tells them apart. */
import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { BracesIcon, FileTextIcon, MessageSquareTextIcon, SearchCheckIcon, WrenchIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/busy-button"
import { CopyButton } from "@/components/ui/copy-button"
import { Notice } from "@/components/notice"
import { Empty } from "@/components/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DataTable, TitleCell } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useCatalogState, useMcpCatalog, useMcpServers, useProjects } from "@/lib/queries/catalog"
import { inlineFromQuery } from "@/lib/errors"
import { ErrorNote } from "@/components/error-note"
import { GroupRowsSkeleton } from "@/components/ui/skeletons"
import { mcpCatalogKey } from "@/lib/queries/keys"
import { mcpDetailPath, mcpEntryPath, settingsPath } from "@/lib/router"
import { api, mcpSubtitle, type McpCheckEntry, type McpCheckResult, type McpServerDef } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { FormPageHeader, Group, INSET, ROW_CONTROL, Row, Section, TabBar } from "./primitives"
import { useSettingsPage } from "./layout"

/** The row and its stored listing — shared by the list page and an entry's page. */
function useMcpListing(entryId: string) {
  const servers = useMcpServers()
  const server = servers.find((s) => s.id === entryId)
  /* A thread-scoped built-in has no server to connect to without a thread, so
     these pages never read one — they explain, like the row they were opened from. */
  const scoped = server?.type === "builtin" && !!server.threadScoped
  const query = useMcpCatalog(entryId, !scoped)
  const rowsState = useCatalogState("mcp-servers")
  return { servers, server, scoped, query, rowsState, result: query.data?.deferred ? null : (query.data ?? null) }
}

/** One entry's page: the contract of a single tool, prompt or resource. */
export function McpEntryPage() {
  const { entryId = "", itemKey = "" } = useParams()
  const navigate = useNavigate()
  const { server, scoped, query, result, rowsState } = useMcpListing(entryId)
  const back = () => void navigate(mcpDetailPath(entryId))
  /* A row or listing still loading is not a missing one: the page's header
     (the entry's name is in its key) over the shape of what is coming. */
  const pendingPage = (
    <>
      <FormPageHeader title={itemKey.slice(itemKey.indexOf(":") + 1)} onBack={back} />
      <GroupRowsSkeleton rows={3} label />
    </>
  )
  if (!server) {
    if (rowsState.isPending) return pendingPage
    if (rowsState.error) return <ListingError error={rowsState.error} onRetry={rowsState.refetch} back={back} />
    return <Navigate to={settingsPath("mcp")} replace />
  }
  if (!scoped && query.isPending) return pendingPage
  const row = entryRows(result).find((r) => r.key === itemKey)
  if (!row) return <Navigate to={mcpDetailPath(entryId)} replace />
  return (
    <>
      <FormPageHeader
        title={row.entry.uri ?? row.entry.name}
        description={row.entry.description}
        meta={
          <>
            <Badge variant="secondary" className="font-normal">
              {KIND_LABEL[row.kind]}
            </Badge>
            {row.entry.mimeType && (
              <Badge variant="outline" className="font-normal">
                {row.entry.mimeType}
              </Badge>
            )}
          </>
        }
        onBack={back}
      />
      <EntryDetail kind={row.kind} entry={row.entry} />
    </>
  )
}

/** The library itself could not be read, so there is no row to draw. */
function ListingError({ error, onRetry, back }: { error: Error; onRetry: () => void; back: () => void }) {
  return (
    <>
      <FormPageHeader title="MCP server" onBack={back} />
      <Section>
        <ErrorNote error={inlineFromQuery(error, "Couldn't read the MCP servers")} onRetry={onRetry} />
      </Section>
    </>
  )
}

export function McpDetailPage() {
  const { entryId = "" } = useParams()
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { server, scoped, query, result, rowsState } = useMcpListing(entryId)
  const projects = useProjects()
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

  const back = () => void navigate(settingsPath("mcp"))
  // A row still loading is an empty list, not a missing server.
  if (!server) {
    if (rowsState.isPending) {
      return (
        <>
          <FormPageHeader title="MCP server" onBack={back} />
          <GroupRowsSkeleton rows={2} label />
        </>
      )
    }
    if (rowsState.error) return <ListingError error={rowsState.error} onRetry={rowsState.refetch} back={back} />
    return <Navigate to={settingsPath("mcp")} replace />
  }

  /* Reached by a direct URL, normally: nothing links here for a thread-scoped
     built-in. There is nothing to list, so the page says why rather than
     offering a Check that cannot connect. */
  if (scoped) {
    return (
      <>
        <FormPageHeader title={server.name} description={mcpSubtitle(server)} onBack={back} />
        <Section>
          <Notice tone="info" title="Listed on the thread that links it">
            This built-in is resolved at spawn, on the calling thread — its connection is that thread's own,
            so there is no server here to connect to. Link it to a profile or a thread to give an agent its
            tools, and read what it offers from that thread.
          </Notice>
        </Section>
      </>
    )
  }

  return (
    <>
      <FormPageHeader
        title={server.name}
        description={mcpSubtitle(server)}
        onBack={back}
        actions={
          <>
            {server.type === "builtin" && projects.length > 1 && (
              <Select value={project} onValueChange={(value) => setProjectId(value ?? "")}>
                <SelectTrigger className={ROW_CONTROL} title="Which project a listing is read against">
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
              loading={busy || query.isFetching}
              onClick={check}
              title="Connect now and list what this server offers"
            >
              <SearchCheckIcon data-icon="inline-start" /> Check
            </Button>
          </>
        }
      />
      {query.error && (
        <Section>
          <ErrorNote
            error={inlineFromQuery(query.error, "Couldn't read what this server offers")}
            onRetry={() => void query.refetch()}
          />
        </Section>
      )}
      <Offering server={server} result={result} pending={query.isPending} failed={!!query.error} />
    </>
  )
}

/**
 * A connected server's surface: what it called itself and declared, its
 * instructions, and every tool, prompt, resource and template as a row of the
 * table. The page's own controls (the project, Check) are its header's.
 */
function Offering({
  server,
  result,
  pending,
  failed,
}: {
  server: McpServerDef
  result: McpCheckResult | null
  /** The stored listing has not answered yet. */
  pending: boolean
  /** It could not be read (said above, by the page). */
  failed: boolean
}) {
  const navigate = useNavigate()
  const rows = React.useMemo(() => entryRows(result), [result])
  const [query, setQuery] = React.useState("")
  const [tab, setTab] = React.useState<EntryTab>("tool")
  const needle = query.trim().toLowerCase()
  const inTab = (row: EntryRow, id: EntryTab) => (id === "resource" ? row.kind === "resource" || row.kind === "template" : row.kind === id)
  const shown = rows.filter((row) => inTab(row, tab) && (!needle || entryMatches(row.entry, needle)))
  const tabCount = (id: EntryTab) => rows.filter((r) => inTab(r, id)).length

  const columns = React.useMemo<ColumnDef<EntryRow, unknown>[]>(
    () => ([
      {
        id: "name",
        header: "Name",
        meta: { title: true, className: "min-w-48" },
        cell: ({ row }) => (
          <TitleCell
            title={row.original.entry.name}
            subtitle={row.original.entry.description?.split("\n")[0]}
          />
        ),
      },
      {
        id: "kind",
        header: "Kind",
        cell: ({ row }) => (
          <Badge variant="secondary" className="font-normal">
            {KIND_LABEL[row.original.kind]}
          </Badge>
        ),
      },
      {
        id: "takes",
        header: "Takes",
        meta: { align: "end" },
        cell: ({ row }) => <span className="text-sm text-muted-foreground tabular-nums">{takesOf(row.original)}</span>,
      },
    ] as ColumnDef<EntryRow, unknown>[]).filter((column) => tab === "resource" || column.id !== "kind"),
    [tab]
  )

  const renderRow = React.useCallback(
    (row: EntryRow) => {
      const Icon = KIND_ICON[row.kind]
      return (
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{row.entry.name}</div>
              <div className="truncate text-sm text-muted-foreground">
                {KIND_LABEL[row.kind]} · {takesOf(row)}
              </div>
            </div>
          </div>
        </div>
      )
    },
    []
  )

  return (
    <>
      <Group
        label={result?.serverInfo?.name ?? server.name}
        hint={result ? (result.ok ? `Listed in ${result.ms}ms.` : undefined) : pending || failed ? undefined : "Not listed yet."}
        action={
          result?.serverInfo?.version && (
            <Badge variant="outline" className="font-normal">
              {result.serverInfo.version}
            </Badge>
          )
        }
      >
        <Row title="Endpoint" subtitle={<span className="font-mono text-xs break-all">{mcpSubtitle(server)}</span>} />
        {/* What the server declared it can do — the protocol's own words,
            so "no prompts" and "prompts it has not listed yet" read apart. */}
        {result?.ok && (
          <Row
            title="Capabilities"
            subtitle={
              Object.keys(result.capabilities ?? {}).filter((key) => key !== "experimental").length === 0
                ? "None declared."
                : undefined
            }
          >
            {Object.keys(result.capabilities ?? {})
              .filter((key) => key !== "experimental")
              .map((key) => (
                <Badge key={key} variant="secondary" className="font-normal">
                  {key}
                </Badge>
              ))}
          </Row>
        )}
        {/* The text a client puts in front of its model — the Daedalus agent
            does, in its system prompt — so it is worth reading here, above
            the table rather than in a sheet. Capped and scrolling in
            itself: a server's instructions can be pages. */}
        {result?.ok && result.instructions && (
          <div className="py-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Instructions</p>
            <p className="max-h-48 overflow-y-auto text-sm/relaxed break-words whitespace-pre-wrap">
              {result.instructions}
            </p>
          </div>
        )}
      </Group>

      {/* `result` is null both while the listing is being read and when the
          server defers its first connection until Check, so the line says
          neither — it just says there is nothing to show yet. */}
      {!result && pending && <GroupRowsSkeleton rows={4} />}
      {!result && !pending && !failed && (
        <Section>
          <Empty size="lg">Not listed yet.</Empty>
        </Section>
      )}

      {result && !result.ok && (
        /* A stdio child's stderr rides the error, so it is a well to select
           from rather than a headline. */
        <Section>
          <Notice
            tone="error"
            title="Didn't connect"
            copy={result.error ?? "The server refused the connection."}
          >
            <pre className="font-mono text-sm whitespace-pre-wrap">
              {result.error ?? "The server refused the connection."}
            </pre>
          </Notice>
        </Section>
      )}

      {result?.ok && (
        <Section>
          <TabBar
            label="What it offers"
            value={tab}
            onChange={(id) => setTab(id as EntryTab)}
            items={ENTRY_TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, count: tabCount(t.id) }))}
          />
          {rows.length > 0 ? (
            <DataTable
              columns={columns}
              data={shown}
              getRowId={(row) => row.key}
              mark={(row) => {
                const Icon = KIND_ICON[row.kind]
                return <Icon className="size-4" />
              }}
              mobile={{ renderRow }}
              onRowClick={(row) => void navigate(mcpEntryPath(server.id, row.key))}
              pageSize={100}
              maxHeight="30rem"
              emptyIcon={<WrenchIcon />}
              emptyMessage={needle ? undefined : "Nothing of this kind."}
              filtering={{
                search: { value: query, onChange: setQuery, placeholder: "Filter by name or description…" },
                totalCount: tabCount(tab),
              }}
            />
          ) : (
            <Empty size="lg">{NOTHING_TO_RUN}</Empty>
          )}
        </Section>
      )}
    </>
  )
}

/** The page's four kinds: the three things a server offers, plus templates,
    whose URI is the thing a reader fills in. */
type EntryKind = "tool" | "prompt" | "resource" | "template"

/** The page's tabs: a template rides with the resources it is the pattern of. */
type EntryTab = "tool" | "prompt" | "resource"
const ENTRY_TABS: { id: EntryTab; label: string; icon: typeof WrenchIcon }[] = [
  { id: "tool", label: "Tools", icon: WrenchIcon },
  { id: "prompt", label: "Prompts", icon: MessageSquareTextIcon },
  { id: "resource", label: "Resources", icon: FileTextIcon },
]

/** What one entry is called in the header. The protocol's own words,
    lowercased — a prompt is a prompt in every runtime's vocabulary. */
const KIND_LABEL: Record<EntryKind, string> = {
  tool: "Tool",
  prompt: "Prompt",
  resource: "Resource",
  template: "Template",
}

const KIND_ICON = {
  tool: WrenchIcon,
  prompt: MessageSquareTextIcon,
  resource: FileTextIcon,
  template: BracesIcon,
} as const

/** One entry of the table. Its key is its kind *and* its name, because a tool
    and a prompt may share one ("search" is both, often enough). */
interface EntryRow {
  key: string
  kind: EntryKind
  entry: McpCheckEntry
}
const entryRow = (kind: EntryKind, entry: McpCheckEntry): EntryRow => ({ key: `${kind}:${entry.name}`, kind, entry })

/** Every entry the server offers, in the order the kinds run. */
const entryRows = (result: McpCheckResult | null): EntryRow[] => [
  ...(result?.tools ?? []).map((entry) => entryRow("tool", entry)),
  ...(result?.prompts ?? []).map((entry) => entryRow("prompt", entry)),
  ...(result?.resources ?? []).map((entry) => entryRow("resource", entry)),
  ...(result?.resourceTemplates ?? []).map((entry) => entryRow("template", entry)),
]

/** Said by the page when the server offers nothing at all. */
const NOTHING_TO_RUN = "This server advertises nothing to run."

/** The fields an entry takes — a tool's schema, a prompt's arguments, a
    template's variables; a resource takes none, its URI is the request. */
function inputFields(kind: EntryKind, entry: McpCheckEntry): Field[] {
  return kind === "prompt"
    ? promptFields(entry)
    : kind === "template"
      ? templateFields(entry.uri ?? entry.name)
      : kind === "resource"
        ? []
        : schemaFields(entry.inputSchema)
}

/** "3 args" / "no args" — and for a resource, what it reads. */
function takesOf({ kind, entry }: EntryRow): string {
  if (kind === "resource") return entry.mimeType ?? "reads a URI"
  const n = inputFields(kind, entry).length
  return n === 0 ? "no args" : `${n} ${n === 1 ? "arg" : "args"}`
}

/**
 * One tool, prompt, resource or template, drawn as its contract: a bar naming
 * the entry and its type, then the fields it takes and the schema they are
 * typed against. Nothing here runs — this is the reading a person opens the
 * page to make, of what a thread linking this server would be handed.
 */
function EntryDetail({ kind, entry }: { kind: EntryKind; entry: McpCheckEntry }) {
  const inputs = inputFields(kind, entry)
  const outputs = schemaFields(entry.outputSchema)

  /* The page title says the thing that will be requested (a resource's
     URI) and its header the kind and type, so here: the contract. */
  return (
    <>
      <Fields
        label={kind === "resource" ? "Reads" : "Input"}
        fields={inputs}
        schema={entry.inputSchema}
        empty={kind === "resource" ? (entry.uri ?? entry.name) : "Takes no arguments."}
      />
      {kind === "tool" && (
        <Fields
          label="Output"
          fields={outputs}
          schema={entry.outputSchema}
          /* No `outputSchema` is not "answers nothing" — it is the default
             MCP shape, and saying so is the difference between a tool nobody
             can read and one whose answer simply is not typed. */
          empty="No output schema — answers content blocks (text, images or embedded resources)."
        />
      )}
    </>
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
    <Section label={label}>
      {fields.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className={cn("divide-y", INSET)}>
          {fields.map((field) => (
            <li key={field.name} className="px-3 py-2 text-sm">
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
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">Schema</summary>
          <Pane text={JSON.stringify(schema, null, 2)} />
        </details>
      )}
    </Section>
  )
}

/** The schema pane: preformatted, scrolled, with the same Copy every drawn
    error and result in this app carries. */
function Pane({ text, className }: { text: string; className?: string }) {
  return (
    <div className="relative">
      <pre className={cn("overflow-auto rounded-xl border bg-muted/50 p-2.5 pr-9 font-mono text-sm", className ?? "max-h-80")}>
        {text}
      </pre>
      <CopyButton text={text} variant="ghost" size="icon-sm" className="absolute top-1 right-1 pointer-coarse:size-11" />
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
