import * as React from "react"
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  api,
  authSummary,
  mcpNeedsAuth,
  mcpSubtitle,
  type McpAuthProbe,
  type McpCheckResult,
  type McpServerDef,
  type RegistryEntry,
  type ServerSettings,
} from "@/lib/settings"
import { Button } from "@/components/ui/button"
import {
  ChevronDownIcon,
  DownloadIcon,
  GlobeIcon,
  KeyRoundIcon,
  SearchIcon,
  PencilIcon,
  Trash2Icon,
  PlugZapIcon,
  PlusIcon,
  PlugIcon,
  SearchCheckIcon,
  StoreIcon,
  TerminalIcon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { EntityIcon, McpIcon } from "@/components/entity-icon"
import { ImageIcon } from "lucide-react"
import { ErrorNote } from "@/components/error-note"
import { Empty } from "@/components/empty"
import { useConfirm } from "@/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { useInvalidateCatalog, useMcpServers } from "@/lib/queries/catalog"
import { mcpCatalogKey } from "@/lib/queries/keys"
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { useTableFilter } from "@/lib/use-table-filter"
import {
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  LogoUpload,
  PageForm,
  PageHeader,
  Section,
  Segmented,
  StatStrip,
  StatusBadge,
  type StatusTone,
  lines,
  pairs,
} from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibraryImportPage, saveLibraryEntry } from "./library"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { useAsyncAction } from "@/hooks/use-async-action"
import { mcpDetailPath, settingsFormPath, settingsPath } from "@/lib/router"

type BuiltinKind = "web-search" | "knowledge" | "workflow" | "agents" | "harness"

/* `hint` is the sentence the Add menu needs to make a choice; `detail` is the
   phrase the list needs to identify a row already there. */
const BUILTINS: {
  kind: BuiltinKind
  label: string
  hint: string
  detail: string
}[] = [
  { kind: "web-search", label: "Web search", detail: "web search + fetch", hint: "The harness's web search + fetch tools, on the backend in Settings › Web search" },
  { kind: "knowledge", label: "Knowledge base", detail: "per-project knowledge base", hint: "A per-project knowledge base the agent can read and write" },
  { kind: "workflow", label: "Workflows", detail: "multi-step workflows", hint: "Run multi-step workflows: each step is a real thread, mirrored into the calling thread as a subagent" },
  { kind: "agents", label: "Ask agents", detail: "ask other profiles and agents", hint: "Let the agent hand a task to another profile and agent pair (Codex, Claude Code, Daedalus), drawn as a subagent" },
  { kind: "harness", label: "Harness", detail: "manage the harness", hint: "Let the agent manage the harness itself — read and write tasks on the board, list projects, and add profiles" },
]

const builtinOf = (kind: BuiltinKind) => BUILTINS.find((b) => b.kind === kind)

/* ── The page ──
   A status board with a table under it. The question this page answers is
   "which of these is working?", so the four readings come first (how many,
   how many connect, how many need a hand, what they offer in all), and the
   table is the answer per server: what it is, how it connects, whether it did,
   and what it offers. The listing each row draws is the server's own stored
   one (`mcp_catalog`); nothing here connects until Check says so.

   Wide, a row is a table row with its actions revealed on hover and its detail
   (endpoint, OAuth, the failure) one click down. Narrow, the same row is a
   list entry that carries that detail inline, because a phone has no hover and
   no room for a second click to learn why a server is red. */

type Health = "connected" | "auth" | "error" | "idle"

/** One server with the stored reading its row is drawn from. The cells are
    plain functions of this, so no cell calls a hook of its own. */
interface ServerRow {
  server: McpServerDef
  health: Health
  /** The status in words. */
  text: string
  data: McpCheckResult | undefined
  /** The message of a read that failed. */
  readError: string | undefined
  fetching: boolean
}

/** A built-in whose server is a *thread's* own is never connectable from here,
    so its row says so instead of reading a connection it cannot make. */
const isThreadScoped = (server: McpServerDef) => server.type === "builtin" && !!server.threadScoped

/** One server's health, from the stored listing. OAuth that nobody has
    connected outranks the listing: the server will have answered 401, and
    "Offline" would send the reader to debug a thing that needs a Connect. */
function healthOf(server: McpServerDef, data: McpCheckResult | undefined, error: unknown): { health: Health; text: string } {
  if (isThreadScoped(server)) return { health: "idle", text: "Per thread" }
  if (mcpNeedsAuth(server)) return { health: "auth", text: "Needs authorization" }
  if (!!error || (!!data && !data.ok && !data.deferred)) return { health: "error", text: "Offline" }
  if (data?.deferred) return { health: "idle", text: "Not connected" }
  if (data?.ok) return { health: "connected", text: "Connected" }
  return { health: "idle", text: "Reading…" }
}

const TONE: Record<Health, StatusTone> = {
  connected: "ok",
  auth: "warn",
  error: "bad",
  idle: "neutral",
}

const FILTERS: { id: "all" | Exclude<Health, "idle">; label: string }[] = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "auth", label: "Needs auth" },
  { id: "error", label: "Error" },
]
type StatusFilter = (typeof FILTERS)[number]["id"]

/** What a server is, in one line a reader can scan: its URL, its command, or
    what the built-in is for. */
function endpointOf(server: McpServerDef): string {
  if (server.type === "http") return server.url
  if (server.type === "stdio") return [server.command, ...server.args].join(" ")
  return builtinOf(server.builtin)?.hint ?? ""
}

const transportOf = (server: McpServerDef) =>
  server.type === "builtin" ? "Built-in" : server.type === "http" ? "HTTP" : "stdio"

/** The read each row makes, taken out of the query objects so the combined
    answer is plain data (structurally shared, stable between unrelated
    renders). */
const readListings = (results: UseQueryResult<McpCheckResult, Error>[]) =>
  results.map((r) => ({ data: r.data, error: r.error?.message, fetching: r.isFetching }))

export function McpPage() {
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const invalidate = useInvalidateCatalog()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const meta = sectionMeta("mcp")
  const mcpServers = useMcpServers()

  /* The harness's own servers, added from one menu rather than typed in:
     there is nothing to type — the row is a handle, and the command, env and
     credentials are synthesized at spawn. Idempotent server-side (fixed id),
     and an entry is hidden once present, since a second copy is the same row;
     the menu itself goes once all of them are. */
  const has = (kind: BuiltinKind) =>
    mcpServers.some((s) => s.type === "builtin" && s.builtin === kind)
  const inject = async (kind: BuiltinKind) => {
    try {
      await api(settings, `/api/mcp-servers/builtin/${kind}`, { method: "POST" })
      await invalidate("mcp-servers")
    } catch (err) {
      reportError(err, `Couldn't add the ${kind} server`)
    }
  }
  const missing = BUILTINS.filter((b) => !has(b.kind))

  /* The same key and fetch `useMcpCatalog` makes, so a row's own read (the
     mark's) and this one are a single cache entry and a single request — the
     table needs every row's answer in one place, and a hook cannot be called
     in a loop. */
  const listings = useQueries({
    queries: mcpServers.map((s) => ({
      queryKey: mcpCatalogKey(settings, s.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<McpCheckResult>(settings, `/api/mcp-servers/${s.id}/catalog`, { signal }),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      retry: false,
      enabled: !isThreadScoped(s),
    })),
    combine: readListings,
  })

  const rows = React.useMemo<ServerRow[]>(
    () =>
      mcpServers.map((server, i) => {
        const l = listings[i]
        return {
          server,
          ...healthOf(server, l?.data, l?.error),
          data: l?.data,
          readError: l?.error,
          fetching: !!l?.fetching,
        }
      }),
    [mcpServers, listings]
  )

  const [query, setQuery] = React.useState("")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const needle = query.trim().toLowerCase()
  const count = (id: StatusFilter) => (id === "all" ? rows.length : rows.filter((r) => r.health === id).length)
  const offered = rows.reduce((n, r) => n + (r.data?.ok ? r.data.tools.length : 0), 0)
  const shown = rows.filter(
    (r) =>
      (status === "all" || r.health === status) &&
      (!needle || `${r.server.name} ${mcpSubtitle(r.server)}`.toLowerCase().includes(needle))
  )

  /* Row handlers read the latest closure through a ref, so the action list and
     the renderers the table memoises against stay one identity while the page
     re-renders around them. */
  const [checking, setChecking] = React.useState<ReadonlySet<string>>(new Set())
  const latest = React.useRef({ settings, navigate, invalidate, confirm, qc })
  latest.current = { settings, navigate, invalidate, confirm, qc }

  const actions = React.useMemo<TableAction<ServerRow>[]>(
    () => [
      {
        id: "check",
        label: "Check now",
        icon: <SearchCheckIcon className="size-4" />,
        position: "left",
        hidden: (r) => isThreadScoped(r.server),
        disabled: (r) => checking.has(r.server.id) || r.fetching,
        onClick: ({ server }) => {
          const { settings, qc } = latest.current
          setChecking((s) => new Set(s).add(server.id))
          /* The toast flavour, because Check stays on screen: it connects
             *now* — the one door that refuses the stored answer — and writes
             what comes back into the cache the row draws from. */
          api<McpCheckResult>(settings, `/api/mcp-servers/${server.id}/check`, { method: "POST" })
            .then((result) => qc.setQueryData(mcpCatalogKey(settings, server.id), result))
            .catch((err) => reportError(err, `Couldn't check ${server.name}`))
            .finally(() =>
              setChecking((s) => {
                const next = new Set(s)
                next.delete(server.id)
                return next
              })
            )
        },
      },
      {
        id: "edit",
        label: "Edit",
        icon: <PencilIcon className="size-4" />,
        position: "left",
        // A built-in has nothing to edit — it is resolved at spawn, not stored.
        hidden: (r) => r.server.type === "builtin",
        onClick: ({ server }) => void latest.current.navigate(settingsFormPath("mcp", server.id)),
      },
      {
        id: "tools",
        label: "What it offers",
        icon: <WrenchIcon className="size-4" />,
        hidden: (r) => !r.data?.ok,
        onClick: ({ server }) => void latest.current.navigate(mcpDetailPath(server.id)),
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2Icon className="size-4" />,
        tone: "danger",
        onClick: async ({ server }) => {
          const { settings, confirm, invalidate } = latest.current
          if (
            !(await confirm({
              title: `Delete "${server.name}"?`,
              description: `The MCP server is removed from the library and unlinked from every profile and thread that used it. Threads already running keep it until they are restarted.`,
              destructive: true,
              confirmLabel: "Delete",
            }))
          )
            return
          try {
            await api(settings, `/api/mcp-servers/${server.id}`, { method: "DELETE" })
            await invalidate("mcp-servers")
          } catch (err) {
            reportError(err, "Couldn't delete the MCP server")
          }
        },
      },
    ],
    [checking]
  )

  const refresh = React.useCallback(() => latest.current.invalidate("mcp-servers"), [])
  const columns = React.useMemo<ColumnDef<ServerRow, unknown>[]>(
    () => [
      {
        id: "server",
        header: "Server",
        meta: { title: true, className: "min-w-56" },
        cell: ({ row }) => (
          <TitleCell
            title={row.original.server.name}
            subtitle={
              <span className={cn(row.original.server.type !== "builtin" && "font-mono text-[11px]")}>
                {endpointOf(row.original.server)}
              </span>
            }
          />
        ),
      },
      {
        id: "transport",
        header: "Transport",
        meta: { className: "hidden @panel-md:table-cell" },
        cell: ({ row }) => (
          <Badge variant="outline" className="font-normal">
            {transportOf(row.original.server)}
          </Badge>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <McpStatus row={row.original} />,
      },
      {
        id: "offers",
        header: "Offers",
        meta: { align: "end" },
        cell: ({ row }) => <McpOffers row={row.original} />,
      },
    ],
    []
  )

  const renderRow = React.useCallback(
    (row: ServerRow) => <McpMobileRow row={row} settings={latest.current.settings} refresh={refresh} />,
    [refresh]
  )
  const renderExpanded = React.useCallback(
    (row: ServerRow) => <McpExpanded row={row} settings={latest.current.settings} refresh={refresh} />,
    [refresh]
  )

  /* Browse sits beside Import for a reason: they are the same question asked of
     two places — what is already on this machine, and what the world has
     published. Neither writes a row without the form. */
  const newButton = (
    <Button className="h-11 grow @panel-sm:h-9 @panel-sm:grow-0" onClick={() => void navigate(settingsFormPath(meta.id))}>
      <PlusIcon className="size-4" /> New MCP server
    </Button>
  )
  const browseButton = (
    <Button variant="outline" className="h-11 grow @panel-sm:h-9 @panel-sm:grow-0" onClick={() => void navigate(settingsFormPath(meta.id, "browse"))}>
      <StoreIcon className="size-4" /> Browse
    </Button>
  )
  const importButton = (
    <Button variant="outline" className="h-11 grow @panel-sm:h-9 @panel-sm:grow-0" onClick={() => void navigate(settingsFormPath(meta.id, "import"))}>
      <DownloadIcon className="size-4" /> Import
    </Button>
  )
  const builtins = missing.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" className="h-11 grow @panel-sm:h-9 @panel-sm:grow-0" title="Add one of the harness's own MCP servers">
            <PlusIcon className="size-4" /> Add built-in
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        {missing.map(({ kind, label, hint }) => (
          <DropdownMenuItem key={kind} onClick={() => void inject(kind)} title={hint}>
            <McpIcon server={{ id: `builtin:${kind}`, type: "builtin", builtin: kind, name: label }} className="size-4" /> {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <div className="flex flex-wrap gap-2">
            {newButton}
            {browseButton}
            {importButton}
            {builtins}
          </div>
        }
      />
      {rows.length === 0 ? (
        <Empty size="lg" icon={meta.icon} action={newButton}>
          No MCP servers yet — add one, browse the registry, or import from the agents' own configs.
        </Empty>
      ) : (
        <>
          <StatStrip
            stats={[
              { label: "Servers", value: rows.length },
              { label: "Connected", value: count("connected"), tone: count("connected") > 0 ? "ok" : "default" },
              { label: "Need attention", value: count("auth") + count("error"), tone: count("error") > 0 ? "bad" : count("auth") > 0 ? "warn" : "default" },
              { label: "Tools offered", value: offered },
            ]}
          />
          <DataTable
            columns={columns}
            data={shown}
            getRowId={(r) => r.server.id}
            actions={actions}
            mark={(r) => <McpIcon server={r.server} className="size-5" />}
            mobile={{ renderRow }}
            expand={{ render: renderExpanded }}
            pageSize={50}
            emptyIcon={<PlugIcon />}
            emptyMessage={needle || status !== "all" ? "No server matches." : "No MCP servers yet."}
            filtering={{
              search: { value: query, onChange: setQuery, placeholder: "Search MCP servers…" },
              fields: [
                {
                  id: "status",
                  label: "Status",
                  type: "segmented",
                  options: FILTERS.map(({ id, label }) => ({ value: id, label: `${label} ${count(id)}` })),
                },
              ],
              values: { status },
              onChange: (_id, value) => setStatus((value as StatusFilter) || "all"),
              count: status === "all" ? 0 : 1,
              onClear: () => setStatus("all"),
              totalCount: rows.length,
            }}
          />
        </>
      )}
    </>
  )
}

/* ── Cells ── */

function McpStatus({ row }: { row: ServerRow }) {
  return (
    <span className="flex min-w-0" title={row.data?.error ?? row.readError}>
      <StatusBadge tone={TONE[row.health]}>{row.text}</StatusBadge>
    </span>
  )
}

/** How old the listing is, said as the reading's own tooltip: a remembered
    answer must never read as a connection that just happened. */
function listedWhen(result: McpCheckResult) {
  const connected = `connected in ${result.ms}ms`
  if (!result.checkedAt) return connected
  const mins = Math.round((Date.now() - result.checkedAt) / 60_000)
  if (mins < 1) return `${connected}, just now`
  return `${connected}, ${mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`} ago`
}

/**
 * What this server advertises — tools, prompts and resources.
 *
 * Drawn without being asked for: a row that says only its command tells the
 * reader nothing about what a thread linking it actually gets. The result is a
 * *reading*, so it is a badge with the counts in it, and a **link to the
 * server's own page**, where each entry is drawn as the contract it is; the
 * tooltip says how old the remembered answer is. A server that offers nothing
 * is said to, rather than drawn as a row with an empty cell.
 */
function McpOffers({ row }: { row: ServerRow }) {
  const { server, data } = row
  if (isThreadScoped(server) || !data?.ok) return <span className="text-xs text-muted-foreground/60">—</span>
  const groups = (
    [
      ["tools", data.tools],
      ["prompts", data.prompts],
      ["resources", data.resources],
    ] as const
  ).filter(([, list]) => list.length > 0)
  if (groups.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" title={listedWhen(data)}>
        Nothing advertised
      </span>
    )
  }
  return (
    <Link
      to={mcpDetailPath(server.id)}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center pointer-coarse:min-h-11"
      title={`${data.serverInfo?.name ?? server.name} — ${listedWhen(data)}`}
    >
      <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/80">
        <PlugZapIcon /> {groups.map(([label, list]) => `${list.length} ${label}`).join(", ")}
      </Badge>
    </Link>
  )
}

/** The failure, the OAuth state and the thread-scoped explanation — what a
    row has to say beyond its columns. Shared by the table's expanded row and
    the narrow list's inline one, so the two cannot drift. */
function McpDetail({
  row,
  settings,
  refresh,
}: {
  row: ServerRow
  settings: ServerSettings
  refresh: () => Promise<void>
}) {
  const { server, data } = row
  const failure = row.readError ?? (data && !data.ok && !data.deferred ? data.error : undefined)
  return (
    <>
      {isThreadScoped(server) && <McpThreadScoped />}
      {server.type === "http" && server.auth === "oauth" && (
        <McpConnection server={server} settings={settings} refresh={refresh} />
      )}
      {row.health === "error" && failure && (
        <pre className="max-h-40 overflow-auto rounded-md bg-destructive/5 p-2 font-mono text-[11px] whitespace-pre-wrap text-destructive">
          {failure}
        </pre>
      )}
    </>
  )
}

/** The table's expanded row: the facts the columns cut short (the whole
    endpoint, what the server calls itself, how old the reading is), then the
    detail. */
function McpExpanded({
  row,
  settings,
  refresh,
}: {
  row: ServerRow
  settings: ServerSettings
  refresh: () => Promise<void>
}) {
  const { server, data } = row
  const info = data?.ok ? data.serverInfo : undefined
  const facts: [string, React.ReactNode][] = [
    [
      server.type === "http" ? "URL" : server.type === "stdio" ? "Command" : "Purpose",
      <span key="e" className={cn("break-all", server.type !== "builtin" && "font-mono text-[11px]")}>
        {endpointOf(server)}
      </span>,
    ],
    ...(info ? ([["Reports as", `${info.name}${info.version ? ` ${info.version}` : ""}`]] as [string, React.ReactNode][]) : []),
    ...(data?.ok ? ([["Listed", listedWhen(data)]] as [string, React.ReactNode][]) : []),
  ]
  return (
    <div className="space-y-3 py-1">
      <dl className="grid gap-x-6 gap-y-2 text-xs @panel-md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
            <dd className="mt-0.5">{value}</dd>
          </div>
        ))}
      </dl>
      <McpDetail row={row} settings={settings} refresh={refresh} />
    </div>
  )
}

/** The narrow list's row: mark, name, endpoint, status, then the badges and
    whatever needs a hand — there is no hover on a phone and no room for a
    second tap to learn why a server is red. */
function McpMobileRow({
  row,
  settings,
  refresh,
}: {
  row: ServerRow
  settings: ServerSettings
  refresh: () => Promise<void>
}) {
  const { server } = row
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
          <McpIcon server={server} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{server.name}</div>
          <div className={cn("truncate text-xs text-muted-foreground", server.type !== "builtin" && "font-mono text-[11px]")}>
            {endpointOf(server)}
          </div>
          <McpStatus row={row} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-normal">
          {transportOf(server)}
        </Badge>
        {row.data?.ok && <McpOffers row={row} />}
      </div>
      <McpDetail row={row} settings={settings} refresh={refresh} />
    </div>
  )
}

/**
 * Why a thread-scoped built-in has no listing here.
 *
 * Its stdio server is synthesized at spawn from the *calling thread*: its env is
 * that thread's loopback URL (or, for the preview browser, the desktop panel it
 * drives). There is no such server behind a settings screen to connect to and
 * nothing to read, so the row explains the absence rather than drawing an
 * Offline dot and a Check that can only fail.
 */
function McpThreadScoped() {
  return (
    <p className="text-xs text-muted-foreground">
      Resolved at spawn, on the thread that links it — its connection is that thread's own, so there is
      nothing to connect to from Settings. Link it to a profile or a thread to give an agent its tools.
    </p>
  )
}

/**
 * Connect / Reconnect / Disconnect for an `http` row that demands OAuth, and
 * the pill saying which of those it is.
 *
 * Connect POSTs, then opens the authorization URL in a **popup** rather than
 * navigating: the settings page is where the answer has to land, and a full
 * navigation would lose whatever else was half-typed on it. The list is
 * re-read three ways — the popup's `message`, this window regaining `focus`,
 * and a 2s poll while one is open — because a popup blocked, a popup closed
 * by hand, and a flow finished after a tab switch on a phone each defeat
 * exactly one of the three.
 *
 * The error goes inline beside the row rather than into a toast: this is the
 * control the user just pressed, and every failure here (discovery refused,
 * registration refused, the exchange refused) is one they can act on.
 */
function McpConnection({
  server,
  settings,
  refresh,
}: {
  server: McpServerDef & { type: "http" }
  settings: ServerSettings
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)
  const popup = React.useRef<Window | null>(null)
  const [waiting, setWaiting] = React.useState(false)
  const state = server.authState?.kind === "oauth" ? server.authState : null
  const connected = state?.state === "connected"

  /* One effect for all three ways a finished flow is noticed. It runs only
     while a popup is out, so a settings page sitting open costs nothing. */
  React.useEffect(() => {
    if (!waiting) return
    let alive = true
    const done = () => {
      if (!alive) return
      setWaiting(false)
      void refresh()
    }
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { source?: string } | null)?.source === "daedalus-mcp-oauth") done()
    }
    window.addEventListener("message", onMessage)
    window.addEventListener("focus", done)
    const timer = window.setInterval(() => {
      if (popup.current?.closed) done()
      else void refresh()
    }, 2000)
    return () => {
      alive = false
      window.removeEventListener("message", onMessage)
      window.removeEventListener("focus", done)
      window.clearInterval(timer)
    }
  }, [waiting, refresh])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>(
        settings,
        `/api/mcp-servers/${server.id}/authorize`,
        { method: "POST" }
      )
      popup.current = window.open(authorizeUrl, "daedalus-mcp-oauth", "width=520,height=720")
      /* A blocked popup is not a failure to report — the URL is still good,
         so it is opened in a tab instead and the `focus` listener catches the
         return. */
      if (!popup.current) window.open(authorizeUrl, "_blank", "noopener")
      setWaiting(true)
    } catch (err) {
      setError(captureError(err, `Couldn't start authorization for ${server.name}`))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await api(settings, `/api/mcp-servers/${server.id}/authorize`, { method: "DELETE" })
      await refresh()
    } catch (err) {
      setError(captureError(err, `Couldn't disconnect ${server.name}`))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {error && <ErrorNote error={error} className="basis-full" />}
      <Badge variant={connected ? "secondary" : "destructive"} title={state?.error ?? undefined}>
        <KeyRoundIcon /> {authSummary(server.authState)}
      </Badge>
      <Button variant="outline" size="sm" className="h-11 @panel-sm:h-9" disabled={busy || waiting} onClick={() => void connect()}>
        <PlugIcon className="size-4" /> {waiting ? "Waiting…" : connected ? "Reconnect" : "Connect"}
      </Button>
      {state && state.state !== "disconnected" && (
        <Button variant="ghost" size="sm" className="h-11 @panel-sm:h-9" disabled={busy} onClick={() => void disconnect()} title="Revoke and forget these tokens">
          <UnplugIcon className="size-4" /> Disconnect
        </Button>
      )}
    </div>
  )
}

/**
 * The marketplace: search an MCP Registry and install what it lists.
 *
 * Install is deliberately **not** a POST from this page. A row lands in the
 * form, prefilled — because half of what a registry publishes is a
 * `{placeholder}` or a required API key, and a one-click install would write a
 * library row that cannot connect and say nothing about why. The form is where
 * a server is described in this app; browsing only fills it in.
 *
 * The search is the server's (`/api/mcp-registry`, a proxy — see
 * `mcp-registry.ts`), debounced here and aborted on the next keystroke, the
 * same bargain ⌘K's search destination makes. So the search box is the page's
 * and the table under it has none of its own: filtering the rows already
 * fetched would be a second, quieter search that disagrees with the first.
 */
export function McpBrowsePage() {
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const meta = sectionMeta("mcp")
  const mcpServers = useMcpServers()
  const [query, setQuery] = React.useState("")
  const [entries, setEntries] = React.useState<RegistryEntry[] | null>(null)
  const [error, setError] = React.useState<InlineError | null>(null)
  const registryRows = React.useMemo(() => entries ?? [], [entries])
  const f = useTableFilter(registryRows, {
    text: (e) => `${e.qualifiedName} ${e.description}`,
    placeholder: "Filter these results…",
    fields: [{ id: "via", label: "Source", of: (e) => e.via, optionLabel: (v) => (v === "remote" ? "Remote" : v) }],
  })

  React.useEffect(() => {
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      setEntries(null)
      setError(null)
      api<{ entries: RegistryEntry[] }>(settings, `/api/mcp-registry?q=${encodeURIComponent(query)}`, {
        signal: abort.signal,
      })
        .then((r) => setEntries(r.entries))
        .catch((err) => {
          if (abort.signal.aborted) return
          setError(captureError(err, "Couldn't search the MCP registry"))
          setEntries([])
        })
    }, 250)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [settings, query])

  /* A name already in the library is the one fact this page knows that the
     registry does not — and installing a second copy under the same name is
     two servers the agent cannot tell apart. */
  const have = React.useMemo(() => new Set(mcpServers.map((s) => s.name)), [mcpServers])
  const navigateRef = React.useRef(navigate)
  navigateRef.current = navigate
  const install = React.useCallback(
    (entry: RegistryEntry) =>
      void navigateRef.current(settingsFormPath("mcp"), { state: { prefill: entry.server } }),
    []
  )

  const columns = React.useMemo<ColumnDef<RegistryEntry, unknown>[]>(
    () => [
      {
        id: "server",
        header: "Server",
        meta: { title: true, className: "min-w-56" },
        cell: ({ row }) => (
          <TitleCell
            title={row.original.server.name}
            subtitle={<span className="font-mono text-[11px]">{row.original.qualifiedName}</span>}
          />
        ),
      },
      {
        id: "about",
        header: "About",
        meta: { className: "hidden @panel-md:table-cell max-w-72 min-w-48" },
        cell: ({ row }) => (
          <span className="line-clamp-2 text-xs whitespace-normal text-muted-foreground">
            {row.original.description}
          </span>
        ),
      },
      {
        id: "via",
        header: "Transport",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <Badge variant="outline" className="font-normal">
              {row.original.via === "remote" ? "HTTP" : row.original.via}
            </Badge>
            <span className="text-xs text-muted-foreground">{row.original.version}</span>
          </span>
        ),
      },
      {
        id: "needs",
        header: "Needs",
        meta: { className: "hidden @panel-lg:table-cell" },
        cell: ({ row }) =>
          row.original.needs.length > 0 ? (
            <span className="font-mono text-[11px] text-muted-foreground" title={row.original.needs.join(", ")}>
              {row.original.needs.join(", ")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          ),
      },
      {
        id: "install",
        header: "",
        meta: { align: "end" },
        cell: ({ row }) => (
          <span className="flex items-center justify-end gap-2">
            {have.has(row.original.server.name) && <Badge variant="secondary">In library</Badge>}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              aria-label={`Install ${row.original.server.name}`}
              onClick={() => install(row.original)}
            >
              <PlusIcon className="size-4" /> Install
            </Button>
          </span>
        ),
      },
    ],
    [have, install]
  )

  const renderRow = React.useCallback(
    (entry: RegistryEntry) => (
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <RegistryMark entry={entry} className="size-10" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{entry.server.name}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{entry.qualifiedName}</div>
          </div>
        </div>
        <p className="line-clamp-3 text-xs text-muted-foreground">{entry.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal">
            {entry.via === "remote" ? "HTTP" : entry.via}
          </Badge>
          <span className="text-xs text-muted-foreground">{entry.version}</span>
          {have.has(entry.server.name) && <Badge variant="secondary">In library</Badge>}
        </div>
        {entry.needs.length > 0 && (
          <p className="text-[11px] break-words text-muted-foreground">
            Needs: <span className="font-mono">{entry.needs.join(", ")}</span>
          </p>
        )}
        <Button type="button" variant="outline" className="h-11 w-full" aria-label={`Install ${entry.server.name}`} onClick={() => install(entry)}>
          <PlusIcon className="size-4" /> Install
        </Button>
      </div>
    ),
    [have, install]
  )

  return (
    <>
      <FormPageHeader
        title="Browse MCP servers"
        description="Search a public MCP Registry. Installing opens the form prefilled — API keys and placeholders are yours to fill in."
        onBack={() => void navigate(settingsPath(meta.id))}
      />
      <PageForm onSubmit={(e) => e.preventDefault()}>
        <FormShell sections={[{ id: "search", label: "Search" }]}>
          <FormSection id="search" label="Search" hint="Leave empty for the most recently published.">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="github, postgres, figma…"
                aria-label="Search the MCP registry"
                className="h-11 pl-9 text-sm"
                autoFocus
              />
            </div>
            <ErrorNote error={error} />
          </FormSection>
          <Section
            label="Results"
            hint={entries ? `${entries.length} ${entries.length === 1 ? "result" : "results"}` : undefined}
          >
            <DataTable
              columns={columns}
              data={f.rows}
              getRowId={(e) => e.id}
              isLoading={entries === null}
              skeletonRows={5}
              mark={(e) => <RegistryMark entry={e} className="size-5" />}
              mobile={{ renderRow }}
              pageSize={50}
              emptyIcon={<meta.icon />}
              emptyMessage={query || f.narrowed ? "Nothing published matches." : "The registry answered with nothing."}
              filtering={{ ...f.filtering, search: undefined }}
            />
          </Section>
        </FormShell>
      </PageForm>
    </>
  )
}

/** A registry row's mark: the publisher's logo where there is one, else the
    transport's glyph. */
function RegistryMark({ entry, className }: { entry: RegistryEntry; className?: string }) {
  const Fallback = entry.via === "remote" ? GlobeIcon : TerminalIcon
  return (
    <EntityIcon
      src={entry.logoUrl ?? undefined}
      className={className}
      fallback={<Fallback aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />}
    />
  )
}

export function McpImportPage() {
  const invalidate = useInvalidateCatalog()
  return <LibraryImportPage meta={sectionMeta("mcp")} kind="mcpServers" endpoint="/api/mcp-servers" noun="MCP server" refresh={() => invalidate("mcp-servers")} />
}

export function McpFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
  const mcpServers = useMcpServers()
  const server = entryId === "new" ? null : mcpServers.find((item) => item.id === entryId)
  /* What Browse filled in. Route state and not a query string: it is a whole
     definition, it is single-use, and a reload landing on an empty form is
     exactly right — the registry row is still one click away. */
  const prefill = (useLocation().state as { prefill?: McpServerDef } | null)?.prefill ?? null
  // A built-in is not editable (see McpPage); a stale link lands on the list.
  if ((entryId !== "new" && !server) || server?.type === "builtin") {
    return <Navigate to={settingsPath("mcp")} replace />
  }
  return (
    <McpForm
      server={server ?? prefill}
      /* A prefilled form is creating, not editing: it has no id to PUT to. */
      creating={!server}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await invalidate("mcp-servers")
        void navigate(settingsPath("mcp"))
      }}
    />
  )
}

function McpForm({
  server,
  creating = false,
  settings,
  onDone,
}: {
  server: McpServerDef | null
  /** True when `server` is a template to fill in rather than a stored row. */
  creating?: boolean
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: server?.name ?? "",
    logoUrl: server && server.type !== "builtin" ? server.logoUrl ?? "" : "",
    type: (server?.type === "http" ? "http" : "stdio") as "stdio" | "http",
    command: server?.type === "stdio" ? server.command : "",
    args: server?.type === "stdio" ? server.args.join("\n") : "",
    env: server?.type === "stdio" ? server.env.map((e) => `${e.name}=${e.value}`).join("\n") : "",
    url: server?.type === "http" ? server.url : "",
    headers: server?.type === "http" ? server.headers.map((h) => `${h.name}: ${h.value}`).join("\n") : "",
    auth: (server?.type === "http" ? server.auth : "none") as "none" | "oauth",
  }))
  const { busy, error: saveError, run } = useAsyncAction()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  /* What the last probe said, so the form can report it in words rather than
     silently flipping a field the user cannot see. */
  const [probe, setProbe] = React.useState<McpAuthProbe | null>(null)
  const { busy: checking, error: checkError, run: check } = useAsyncAction()

  /** Ask the server how this URL authenticates and remember the answer.
      Returns what to store, so `save` can run the same probe and use it
      without waiting for a re-render. */
  const runProbe = async (): Promise<"none" | "oauth"> => {
    const answer = await api<McpAuthProbe>(settings, "/api/mcp-servers/probe", {
      method: "POST",
      body: JSON.stringify({ url: form.url }),
    })
    setProbe(answer)
    /* `unknown` deliberately keeps whatever the row already said: a 403 from a
       corporate proxy, or a host that is simply down, is not evidence either
       way, and flipping the row on it would silently un-advertise a server
       that works. */
    const next = answer.kind === "unknown" ? form.auth : answer.kind
    set({ auth: next })
    return next
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void run("Couldn't save the MCP server", async () => {
      /* The probe runs on save for an HTTP row, which is what makes a server
         that answers 401 land in the library already marked `oauth` with
         Connect waiting on it. Best-effort: a probe that throws must not cost
         somebody the row they just typed. */
      let auth = form.auth
      if (form.type === "http") {
        try {
          auth = await runProbe()
        } catch {
          /* keep whatever the row said */
        }
      }
      const payload =
        form.type === "http"
          ? { type: "http", name: form.name, logoUrl: form.logoUrl.trim() || undefined, url: form.url, headers: pairs(form.headers, ":"), auth }
          : {
              type: "stdio",
              name: form.name,
              logoUrl: form.logoUrl.trim() || undefined,
              command: form.command,
              args: lines(form.args),
              env: pairs(form.env, "="),
            }
      await saveLibraryEntry(settings, "/api/mcp-servers", creating ? undefined : server?.id, payload)
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={server && !creating ? `Edit ${server.name}` : "New MCP server"}
        description="Define how projects connect to this MCP server."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <FormShell
        sections={[
          { id: "identity", label: "Identity" },
          { id: "connection", label: form.type === "http" ? "Remote endpoint" : "Local process" },
        ]}
      >
      <FormSection id="identity" label="Identity" hint="What the agent calls it and how it is drawn.">
      <div className="grid gap-4 @panel-sm:grid-cols-2">
        <Field label="Name" hint="How the agent addresses the server.">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Logo" hint="Paste an image URL or upload one. With none, the harness uses the server's own logo or favicon.">
          <div className="flex items-center gap-2">
            <EntityIcon
              src={form.logoUrl}
              className="size-8"
              fallback={<span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><ImageIcon className="size-4" /></span>}
            />
            <Input
              type="url"
              value={form.logoUrl.startsWith("data:") ? "" : form.logoUrl}
              onChange={(e) => set({ logoUrl: e.target.value })}
              placeholder={form.logoUrl.startsWith("data:") ? "Uploaded image" : "https://example.com/logo.png"}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <LogoUpload value={form.logoUrl} onChange={(logoUrl) => set({ logoUrl })} />
          </div>
        </Field>
        <Field label="Transport">
          <Segmented
            label="Transport"
            value={form.type}
            onChange={(type) => set({ type })}
            options={[
              { value: "stdio", label: "stdio" },
              { value: "http", label: "HTTP" },
            ]}
          />
        </Field>
      </div>
      </FormSection>
      <FormSection
        id="connection"
        label={form.type === "http" ? "Remote endpoint" : "Local process"}
        hint={form.type === "http" ? "Where the server lives and how it is reached." : "What the server runs, on the machine the harness runs on."}
      >
      {form.type === "http" ? (
        <>
          <Field
            label="URL"
            hint="Check asks the server how it authenticates — a server that answers 401 is stored as OAuth and can be connected from the list."
          >
            <div className="flex flex-wrap items-start gap-2 @panel-sm:flex-nowrap">
              <Input
                value={form.url}
                onChange={(e) => set({ url: e.target.value, auth: "none" })}
                placeholder="https://mcp.example.com/mcp"
                className="min-w-0 flex-1 basis-full font-mono text-xs @panel-sm:basis-0"
                required
              />
              <Button
                type="button"
                variant="outline"
                className="h-11 @panel-sm:h-9"
                disabled={!form.url || checking}
                onClick={() => void check("Couldn't check the MCP server", async () => void (await runProbe()))}
              >
                <SearchCheckIcon className="size-4" /> Check
              </Button>
            </div>
          </Field>
          {probe && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {probe.kind === "oauth"
                ? `Needs OAuth — ${probe.issuer}. Save, then Connect from the list.`
                : probe.kind === "none"
                  ? "Answers without authorization. Any headers below still travel."
                  : `Couldn't tell (${probe.status || "no response"}): ${probe.detail}`}
            </p>
          )}
          <ErrorNote error={checkError} />
          <Field label="Headers" hint="One per line: Name: value">
            <Textarea
              value={form.headers}
              onChange={(e) => set({ headers: e.target.value })}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Command" hint="Runs on the server, spawned by the agent.">
            <Input
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              placeholder="npx"
              className="font-mono text-xs"
              required
            />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <Textarea
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Environment" hint="One per line: NAME=value">
            <Textarea
              value={form.env}
              onChange={(e) => set({ env: e.target.value })}
              rows={2}
              className="font-mono text-xs"
            />
          </Field>
        </>
      )}
      </FormSection>
      </FormShell>
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
