/* ── The MCP playground ──
   What a server is *for*: the tools, prompts and resources it puts in front
   of an agent — what each one takes, what it answers — and a playground that
   runs any of them.

   Two pages, one playground. `McpDetailPage` is a library row's (the row's
   badge links there, and builtins and OAuth rows resolve server-side exactly
   as a spawn would); `McpPlaygroundPage` is any server at all, typed in or
   handed over by the form's "Try it", and saved only if somebody asks.
   `McpPlayground` below them knows neither: it is given a listing and a
   `call`, and where the call goes is the page's business.

   The four sections are one component (`EntryRow`) rather than four, because
   the only thing that differs between running a tool, a prompt and a resource
   is the word in the request — the fields, the answer pane and the failure are
   the same surface. `POST …/invoke` is the same shape on the server for the
   same reason.

   A chunk of its own (`sections.ts` lazy-loads it), so the library list does
   not carry the playground. */
import * as React from "react"
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { PlayIcon, PlugIcon, SaveIcon, SearchCheckIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { McpIcon } from "@/components/entity-icon"
import { CopyButton } from "@/components/ui/copy-button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/notice"
import { Empty } from "@/components/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useMcpCatalog, useMcpServers, useProjects } from "@/lib/queries/catalog"
import { mcpCatalogKey } from "@/lib/queries/keys"
import { mcpDetailPath, settingsFormPath, settingsPath } from "@/lib/router"
import {
  api,
  mcpNeedsAuth,
  mcpSubtitle,
  type McpCheckEntry,
  type McpCheckResult,
  type McpCompletionRef,
  type McpCallResult,
  type McpInvokeKind,
  type McpServerDef,
} from "@/lib/settings"
import { Field, FormPageHeader, Group, PageForm, Row, lines, pairs } from "./primitives"
import { useSettingsPage } from "./layout"

/** Where a playground's calls go. The page decides — a row's own routes, or
    the ad-hoc door carrying the definition — and nothing below it knows. */
type McpCall = <T>(op: "invoke" | "complete", body: Record<string, unknown>) => Promise<T>

export function McpDetailPage() {
  const { entryId = "" } = useParams()
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const servers = useMcpServers()
  const server = servers.find((s) => s.id === entryId)
  const projects = useProjects()
  const query = useMcpCatalog(entryId)
  const { busy, run } = useAsyncAction({ toast: true })

  /* Which project a call runs against. It matters only for the harness's own
     servers — a builtin's env carries the calling thread's project, and there
     is no thread behind this page — so the picker is drawn only for those; for
     everything else the server is the same server in every directory. */
  const [projectId, setProjectId] = React.useState("")
  const project = projectId || projects[0]?.id || ""

  const call = React.useCallback<McpCall>(
    (op, body) =>
      api(settings, `/api/mcp-servers/${entryId}/${op}`, {
        method: "POST",
        body: JSON.stringify({ ...body, project }),
      }),
    [settings, entryId, project]
  )

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

  return (
    <div className="mx-auto w-full max-w-3xl">
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
      {server.id === "chrome-devtools-mcp" && !query.data?.ok && (
        <Notice tone="info" title="Chrome runs on the harness server">
          Press Check to start Chrome DevTools MCP. With Chrome 144 or newer, enable remote debugging at
          chrome://inspect/#remote-debugging; Chrome will ask you to approve the connection. The agent uses
          the MCP permission gate for browser actions.
        </Notice>
      )}
      <McpPlayground result={query.data?.deferred ? null : query.data ?? null} call={call}>
        {server.type === "builtin" && projects.length > 1 && (
          <Select value={project} onValueChange={(value) => setProjectId(value ?? "")}>
            <SelectTrigger size="sm" className="w-56" title="Which project a call runs against">
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
      </McpPlayground>
    </div>
  )
}

/** A server as the playground's form holds it — every field a string, the
    same shape the library form keeps, so its "Try it" hands its state over
    whole. `sse` is the one transport the library cannot store yet, and only
    the playground offers it. */
export interface McpTransportForm {
  type: "stdio" | "http" | "sse"
  command: string
  args: string
  env: string
  url: string
  headers: string
}

const BLANK: McpTransportForm = { type: "stdio", command: "", args: "", env: "", url: "", headers: "" }

/** The form as the definition the ad-hoc routes validate. */
function serverOf(form: McpTransportForm) {
  return form.type === "stdio"
    ? { type: "stdio", command: form.command.trim(), args: lines(form.args), env: pairs(form.env, "=") }
    : { type: form.type, url: form.url.trim(), headers: pairs(form.headers, ":") }
}

/**
 * Any MCP server, without a library row: typed in here, or handed over by the
 * library form's "Try it" (route state, like Browse's prefill — a reload
 * lands on an empty form, which is right for something that was never saved).
 *
 * Calls go to the server that was *connected*, not to whatever the fields say
 * now: a half-edited command must not be what a Run press spawns. Connecting
 * again is what picks up an edit, and it starts every row afresh (`key`).
 */
function ConnectedMcpServers() {
  const servers = useMcpServers().filter((server) => !mcpNeedsAuth(server))

  if (servers.length === 0) return null

  return (
    <Group label="Saved MCP servers" hint="Open a connected library server directly in the playground.">
      {servers.map((server) => (
        <Link
          key={server.id}
          to={mcpDetailPath(server.id)}
          className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Row
            icon={<McpIcon server={server} className="size-4" />}
            title={server.name}
            subtitle={mcpSubtitle(server)}
          />
        </Link>
      ))}
    </Group>
  )
}

export function McpPlaygroundPage() {
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const prefill = (useLocation().state as { prefill?: Partial<McpTransportForm> } | null)?.prefill
  const [form, setForm] = React.useState<McpTransportForm>(() => ({ ...BLANK, ...prefill }))
  const set = (patch: Partial<McpTransportForm>) => setForm((f) => ({ ...f, ...patch }))
  const [live, setLive] = React.useState<{ server: ReturnType<typeof serverOf>; result: McpCheckResult } | null>(
    null
  )
  const { busy, run } = useAsyncAction({ toast: true })

  const connect = React.useCallback(
    (target: McpTransportForm) =>
      void run("Couldn't reach the playground", async () => {
        const server = serverOf(target)
        const result = await api<McpCheckResult>(settings, "/api/mcp-playground/check", {
          method: "POST",
          body: JSON.stringify({ server }),
        })
        setLive({ server, result })
      }),
    [run, settings]
  )

  /* Handed a server is asked to try it: connect on arrival. Once — a strict
     mode double effect would spawn a stdio server twice. */
  const arrived = React.useRef(false)
  React.useEffect(() => {
    if (!prefill || arrived.current) return
    arrived.current = true
    connect({ ...BLANK, ...prefill })
  }, [prefill, connect])

  const call = React.useCallback<McpCall>(
    (op, body) =>
      api(settings, `/api/mcp-playground/${op}`, {
        method: "POST",
        body: JSON.stringify({ ...body, server: live?.server }),
      }),
    [settings, live]
  )

  /* Saving is the ordinary form, prefilled — the same door Browse uses, so the
     name, the OAuth probe and validation stay the form's. */
  const save = () => {
    const server = serverOf(form)
    const prefillDef = { id: "", name: "", ...server, ...(server.type === "http" ? { auth: "none" } : {}) }
    void navigate(settingsFormPath("mcp", "new"), { state: { prefill: prefillDef as McpServerDef } })
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <FormPageHeader
        title="MCP playground"
        description="Connect to any MCP server, saved or not, and run what it offers. Nothing here is stored until you save it to the library."
        onBack={() => void navigate(settingsPath("mcp"))}
      />
      <ConnectedMcpServers />
      <PageForm
        className="mb-8"
        onSubmit={(e) => {
          e.preventDefault()
          connect(form)
        }}
      >
        <Field label="Transport">
          <Select value={form.type} onValueChange={(type) => set({ type: (type as McpTransportForm["type"]) ?? "stdio" })}>
            <SelectTrigger className="w-full @panel-sm:w-56">
              <SelectValue>{TRANSPORTS[form.type]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TRANSPORTS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {form.type === "stdio" ? (
          <>
            <Field label="Command" hint="Runs on the server, as a thread's agent would spawn it.">
              <Input
                value={form.command}
                onChange={(e) => set({ command: e.target.value })}
                placeholder="npx"
                className="font-mono text-xs"
                required
              />
            </Field>
            <div className="grid gap-4 @panel-sm:grid-cols-2">
              <Field label="Arguments" hint="One per line.">
                <Textarea
                  value={form.args}
                  onChange={(e) => set({ args: e.target.value })}
                  rows={3}
                  placeholder={"-y\n@modelcontextprotocol/server-everything"}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Environment" hint="One per line: NAME=value">
                <Textarea
                  value={form.env}
                  onChange={(e) => set({ env: e.target.value })}
                  rows={3}
                  className="font-mono text-xs"
                />
              </Field>
            </div>
          </>
        ) : (
          <>
            <Field
              label="URL"
              hint="A server that wants OAuth has to be saved and connected from the library first — its token needs a row to belong to."
            >
              <Input
                value={form.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder={form.type === "sse" ? "https://mcp.example.com/sse" : "https://mcp.example.com/mcp"}
                className="font-mono text-xs"
                required
              />
            </Field>
            <Field label="Headers" hint="One per line: Name: value">
              <Textarea
                value={form.headers}
                onChange={(e) => set({ headers: e.target.value })}
                rows={2}
                className="font-mono text-xs"
              />
            </Field>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            <PlugIcon className="size-4" /> {busy ? "Connecting…" : live ? "Reconnect" : "Connect"}
          </Button>
          {/* The library cannot store SSE yet, so there is nothing to save it as. */}
          {form.type !== "sse" && (
            <Button type="button" variant="outline" onClick={save}>
              <SaveIcon className="size-4" /> Save to library
            </Button>
          )}
        </div>
      </PageForm>
      {live && <McpPlayground key={JSON.stringify(live.server)} result={live.result} call={call} />}
    </div>
  )
}

const TRANSPORTS: Record<McpTransportForm["type"], string> = {
  stdio: "stdio",
  http: "Streamable HTTP",
  sse: "SSE (legacy)",
}

/**
 * A connected server's surface: what it called itself and declared, its
 * instructions, and every tool, prompt, resource and template as a runnable
 * row. `children` are the page's own controls, drawn at the end of the badge
 * row.
 */
function McpPlayground({
  result,
  call,
  children,
}: {
  result: McpCheckResult | null
  call: McpCall
  children?: React.ReactNode
}) {
  const sections: { kind: EntryKind; label: string; entries: McpCheckEntry[] }[] = [
    { kind: "tool", label: "Tools", entries: result?.tools ?? [] },
    { kind: "prompt", label: "Prompts", entries: result?.prompts ?? [] },
    { kind: "resource", label: "Resources", entries: result?.resources ?? [] },
    { kind: "template", label: "Resource templates", entries: result?.resourceTemplates ?? [] },
  ]
  const completions = Boolean(result?.capabilities?.completions)

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {result?.serverInfo && (
          <Badge variant="outline" className="font-normal">
            {result.serverInfo.name} {result.serverInfo.version}
          </Badge>
        )}
        {/* What the server declared it can do — the protocol's own words,
            so "no prompts" and "prompts it has not listed yet" read apart. */}
        {Object.keys(result?.capabilities ?? {})
          .filter((key) => key !== "experimental")
          .map((key) => (
            <Badge key={key} variant="secondary" className="font-normal">
              {key}
            </Badge>
          ))}
        {result?.ok && <span className="text-xs text-muted-foreground">listed in {result.ms}ms</span>}
        {children}
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
        <div className="space-y-6">
          {/* The text a client puts in front of its model — the Daedalus agent
              does, in its system prompt — so it is worth reading here. */}
          {result.instructions && (
            <Group label="Instructions">
              <p className="py-3 text-sm whitespace-pre-wrap">{result.instructions}</p>
            </Group>
          )}
          {sections.map(({ kind, label, entries }) =>
            /* Tools are drawn even when there are none — a server offering no
               tools is the answer somebody came here for. The others are
               simply absent, since most servers have none. */
            kind === "tool" || entries.length > 0 ? (
              <Group key={kind} label={label}>
                {entries.length === 0 ? (
                  <Empty size="sm">This server advertises no {label.toLowerCase()}.</Empty>
                ) : (
                  entries.map((entry) => (
                    <EntryRow key={entry.name} kind={kind} entry={entry} call={call} completions={completions} />
                  ))
                )}
              </Group>
            ) : null
          )}
        </div>
      )}
    </>
  )
}

/**
 * One tool, prompt or resource: what it takes, what it answers, and the
 * playground that runs it.
 *
 * `<details>` rather than an accordion component — the browser already has "a
 * heading that opens something", it is keyboard- and screen-reader-correct for
 * free, and a page of forty tools should not mount forty argument boxes.
 *
 * The arguments are a **JSON textarea**, not a form generated from the schema.
 * A generated form has to answer `oneOf`, nested objects, arrays of objects and
 * everything else JSON Schema can say, and it would still be a worse editor
 * than a textarea for the person debugging why a tool rejects their payload.
 * What the schema is *for* here is the field list beside it, which is the part
 * a person actually reads.
 * ponytail: a generated form when a tool's arguments are routinely long, never
 * before.
 */
/** The page's four sections: the three things a server runs, plus templates,
    which run as a resource read once their variables are filled in. */
type EntryKind = McpInvokeKind | "template"

function EntryRow({
  kind,
  entry,
  call: send,
  completions,
}: {
  kind: EntryKind
  entry: McpCheckEntry
  call: McpCall
  /** The server answers `completion/complete`, so arguments can be suggested. */
  completions: boolean
}) {
  const inputs =
    kind === "prompt"
      ? promptFields(entry)
      : kind === "template"
        ? templateFields(entry.uri ?? entry.name)
        : schemaFields(entry.inputSchema)
  const outputs = schemaFields(entry.outputSchema)
  const [args, setArgs] = React.useState(() => argsSkeleton(inputs))
  const [result, setResult] = React.useState<McpCallResult | null>(null)
  const [invalid, setInvalid] = React.useState<string | null>(null)
  const { busy, run } = useAsyncAction({ toast: true })

  const call = () => {
    let parsed: unknown = {}
    if (kind !== "resource") {
      try {
        parsed = args.trim() ? JSON.parse(args) : {}
      } catch (err) {
        /* Caught here rather than sent: a JSON typo is not a round trip, and
           the message the parser gives names the character. */
        setInvalid((err as Error).message)
        return
      }
    }
    setInvalid(null)
    const name =
      kind === "template"
        ? fillTemplate(entry.uri ?? entry.name, parsed as Record<string, unknown>)
        : kind === "resource"
          ? (entry.uri ?? entry.name)
          : entry.name
    void run(`Couldn't run ${entry.name}`, async () => {
      setResult(null)
      setResult(
        await send<McpCallResult>("invoke", { kind: kind === "template" ? "resource" : kind, name, args: parsed })
      )
    })
  }

  /* Suggestions for each argument from its current value — the server ranks
     them (`completion/complete`), and a pick writes the value into the JSON. */
  const [suggestions, setSuggestions] = React.useState<Record<string, string[]> | null>(null)
  const ref: McpCompletionRef | null =
    kind === "prompt"
      ? { type: "ref/prompt", name: entry.name }
      : kind === "template"
        ? { type: "ref/resource", uri: entry.uri ?? entry.name }
        : null
  const suggest = () => {
    let current: Record<string, unknown> = {}
    try {
      current = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {}
    } catch (err) {
      setInvalid((err as Error).message)
      return
    }
    setInvalid(null)
    const context = Object.fromEntries(
      Object.entries(current).filter(([, v]) => typeof v === "string") as [string, string][]
    )
    void run(`Couldn't ask ${entry.name} for suggestions`, async () => {
      const answers = await Promise.all(
        inputs.map(async (field) => {
          const { values } = await send<{ values: string[] }>("complete", {
            ref,
            argument: { name: field.name, value: String(current[field.name] ?? "") },
            context,
          })
          return [field.name, values] as const
        })
      )
      setSuggestions(Object.fromEntries(answers))
    })
  }
  const choose = (field: string, value: string) => {
    let current: Record<string, unknown> = {}
    try {
      current = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {}
    } catch {
      // A broken payload is replaced by the one value picked; the rest was unreadable anyway.
    }
    setArgs(JSON.stringify({ ...current, [field]: value }, null, 2))
  }

  const answer = result && JSON.stringify(result.error ?? result.result, null, 2)
  const images = result?.ok ? imagesIn(result.result) : []

  return (
    <details className="group py-3">
      <summary className="cursor-pointer list-none">
        <span className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-sm">{entry.name}</span>
          {entry.mimeType && (
            <Badge variant="outline" className="font-normal">
              {entry.mimeType}
            </Badge>
          )}
        </span>
        {entry.description && (
          <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground group-open:line-clamp-none">
            {entry.description}
          </span>
        )}
      </summary>

      <div className="mt-3 space-y-3">
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

        {kind !== "resource" && (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor={`args-${kind}-${entry.name}`}>
              Arguments (JSON)
            </label>
            <Textarea
              id={`args-${kind}-${entry.name}`}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              className="min-h-24 font-mono text-xs"
            />
            {suggestions && (
              <div className="mt-2 space-y-1">
                {Object.entries(suggestions).map(([field, values]) => (
                  <div key={field} className="flex flex-wrap items-center gap-1 text-xs">
                    <span className="font-mono text-muted-foreground">{field}</span>
                    {values.length === 0 ? (
                      <span className="text-muted-foreground">no suggestions</span>
                    ) : (
                      values.slice(0, 12).map((value) => (
                        <Button
                          key={value}
                          variant="outline"
                          size="xs"
                          className="font-mono"
                          onClick={() => choose(field, value)}
                        >
                          {value}
                        </Button>
                      ))
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {invalid && <Notice tone="warn">{invalid}</Notice>}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={call}>
            <PlayIcon className="size-4" /> {busy ? "Running…" : "Run"}
          </Button>
          {completions && ref && inputs.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={suggest}>
              <SparklesIcon className="size-4" /> Suggest values
            </Button>
          )}
          {result && (
            <span className="text-xs text-muted-foreground">
              {result.ok ? "answered" : "failed"} in {result.ms}ms
            </span>
          )}
        </div>

        {/* Something that ran and reported failure is still an answer — the
            page draws it as one, and only a call that never happened is an
            error. */}
        {answer && (
          <>
            {!result?.ok && <Notice tone="error">The call didn't complete.</Notice>}
            {/* An image is drawn as one — base64 in the pane beside it is what
                the answer *is*, but not what anyone came to look at. */}
            {images.map((src, i) => (
              <img key={i} src={src} alt="" className="max-h-80 max-w-full rounded-md border" />
            ))}
            <Pane text={answer} />
          </>
        )}
      </div>
    </details>
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

/** The output pane: preformatted, scrolled, with the Copy every drawn error
    and every result in this app carries. */
function Pane({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2.5 pr-9 font-mono text-xs">{text}</pre>
      <CopyButton text={text} variant="ghost" size="icon" className="absolute top-1 right-1" />
    </div>
  )
}

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

/**
 * A starting payload: the *required* arguments, each at its type's empty
 * value.
 *
 * Only the required ones, because a skeleton carrying every optional field is
 * a payload that says things the caller did not mean — an empty string where
 * the server's own default was wanted.
 */
function argsSkeleton(fields: Field[]): string {
  const required = fields.filter((f) => f.required)
  if (required.length === 0) return "{}"
  const out: Record<string, unknown> = {}
  for (const field of required) {
    out[field.name] = field.type.startsWith("number")
      ? 0
      : field.type.startsWith("integer")
        ? 0
        : field.type.startsWith("boolean")
          ? false
          : field.type.endsWith("[]")
            ? []
            : field.type === "object"
              ? {}
              : ""
  }
  return JSON.stringify(out, null, 2)
}

/** A template's variables — `{name}`, `{+path}`, `{?q,page}` — as the field
    list its arguments are typed against. */
function templateFields(template: string): Field[] {
  const names = new Set<string>()
  for (const [, expr] of template.matchAll(/\{([^}]+)\}/g)) {
    for (const name of expr.replace(/^[+#./;?&]/, "").split(",")) names.add(name.replace(/[*:].*$/, ""))
  }
  return [...names].map((name) => ({ name, type: "string", required: true }))
}

/**
 * RFC 6570, the operators servers actually publish: `{x}` is escaped, `{+x}`
 * and `{#x}` keep reserved characters, `{/x}` and `{.x}` prefix, `{?x,y}` and
 * `{&x}` build a query.
 * ponytail: no prefix modifiers (`{x:3}`) or exploded lists (`{x*}`) — the SDK's
 * `UriTemplate` if a server ever needs them.
 */
function fillTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, expr: string) => {
    const op = /^[+#./;?&]/.test(expr) ? expr[0] : ""
    const names = (op ? expr.slice(1) : expr).split(",").map((n) => n.replace(/[*:].*$/, ""))
    const present = names.filter((n) => values[n] !== undefined && values[n] !== "")
    const enc = (v: unknown) => (op === "+" || op === "#" ? encodeURI(String(v)) : encodeURIComponent(String(v)))
    if (op === "?" || op === "&") {
      const pairs = present.map((n) => `${n}=${enc(values[n])}`).join("&")
      return pairs ? `${op}${pairs}` : ""
    }
    const joined = present.map((n) => enc(values[n])).join(",")
    return joined && (op === "/" || op === "." || op === "#") ? op + joined : joined
  })
}

/** Every image in an answer — a tool's `image` blocks, a resource's image
    `blob`s, an embedded resource's — as data URLs. */
function imagesIn(result: unknown): string[] {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    const v = value as Record<string, unknown>
    const mime = typeof v.mimeType === "string" ? v.mimeType : ""
    if (mime.startsWith("image/")) {
      const data = typeof v.data === "string" ? v.data : typeof v.blob === "string" ? v.blob : null
      if (data) out.push(`data:${mime};base64,${data}`)
    }
    for (const key of ["content", "contents", "resource", "messages"]) if (key in v) walk(v[key])
  }
  walk(result)
  return out
}
