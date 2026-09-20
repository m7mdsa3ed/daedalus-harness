/* ── One MCP server's own page ──
   What the library row is *for*: the tools, prompts and resources it puts in
   front of an agent — what each one takes, what it answers — and a playground
   that runs any of them.

   A page rather than the popover this replaced, for the reason a project has a
   page: a tool has a name, a description, an input schema and an output schema,
   a prompt has arguments, a resource has a URI and a type, and none of that
   fits a surface floating over a table row. The row's badge links here.

   The three sections are one component (`EntryRow`) rather than three, because
   the only thing that differs between running a tool, a prompt and a resource
   is the word in the request — the fields, the playground, the answer pane and
   the failure are the same surface. `POST …/invoke` is the same shape on the
   server for the same reason.

   A chunk of its own (`routes.tsx` lazy-loads it), so the library list does not
   carry the playground. */
import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { useQueryClient } from "@tanstack/react-query"
import { PlayIcon, SearchCheckIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/notice"
import { Empty } from "@/components/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useMcpCatalog, useMcpServers, useProjects } from "@/lib/queries/catalog"
import { mcpCatalogKey } from "@/lib/queries/keys"
import { settingsPath } from "@/lib/router"
import {
  api,
  mcpSubtitle,
  type McpCheckEntry,
  type McpCheckResult,
  type McpCallResult,
  type McpInvokeKind,
  type ServerSettings,
} from "@/lib/settings"
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
  const query = useMcpCatalog(entryId)
  const result = query.data ?? null
  const { busy, run } = useAsyncAction({ toast: true })

  /* Which project a call runs against. It matters only for the harness's own
     servers — a builtin's env carries the calling thread's project, and there
     is no thread behind this page — so the picker is drawn only for those; for
     everything else the server is the same server in every directory. */
  const [projectId, setProjectId] = React.useState("")
  const project = projectId || projects[0]?.id || ""

  const check = () =>
    void run(`Couldn't check ${server?.name ?? "this server"}`, async () => {
      qc.setQueryData(
        mcpCatalogKey(settings, entryId),
        await api<McpCheckResult>(settings, `/api/mcp-servers/${entryId}/check`, { method: "POST" })
      )
    })

  // A row still loading is an empty list, not a missing server.
  if (!server) return servers.length === 0 ? null : <Navigate to={settingsPath("mcp")} replace />

  const sections: { kind: McpInvokeKind; label: string; entries: McpCheckEntry[] }[] = [
    { kind: "tool", label: "Tools", entries: result?.tools ?? [] },
    { kind: "prompt", label: "Prompts", entries: result?.prompts ?? [] },
    { kind: "resource", label: "Resources", entries: result?.resources ?? [] },
  ]

  return (
    <div className="mx-auto w-full max-w-3xl">
      <FormPageHeader
        title={server.name}
        description={mcpSubtitle(server)}
        onBack={() => void navigate(settingsPath("mcp"))}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {result?.serverInfo && (
          <Badge variant="outline" className="font-normal">
            {result.serverInfo.name} {result.serverInfo.version}
          </Badge>
        )}
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
      </div>

      {query.error && (
        <Notice tone="error" title="Couldn't read what this server offers">
          {query.error.message}
        </Notice>
      )}
      {result && !result.ok && (
        <Notice tone="error" title="Didn't connect">
          {result.error ?? "The server refused the connection."}
        </Notice>
      )}

      {result?.ok && (
        <div className="space-y-6">
          {sections.map(({ kind, label, entries }) =>
            /* Tools are drawn even when there are none — a server offering no
               tools is the answer somebody came here for. The other two are
               simply absent, since most servers have neither. */
            kind === "tool" || entries.length > 0 ? (
              <Group key={kind} label={label}>
                {entries.length === 0 ? (
                  <Empty size="sm">This server advertises no {label.toLowerCase()}.</Empty>
                ) : (
                  entries.map((entry) => (
                    <EntryRow
                      key={entry.name}
                      kind={kind}
                      entry={entry}
                      serverId={entryId}
                      project={project}
                      settings={settings}
                    />
                  ))
                )}
              </Group>
            ) : null
          )}
        </div>
      )}
    </div>
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
function EntryRow({
  kind,
  entry,
  serverId,
  project,
  settings,
}: {
  kind: McpInvokeKind
  entry: McpCheckEntry
  serverId: string
  project: string
  settings: ServerSettings
}) {
  const inputs = kind === "prompt" ? promptFields(entry) : schemaFields(entry.inputSchema)
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
    void run(`Couldn't run ${entry.name}`, async () => {
      setResult(null)
      setResult(
        await api<McpCallResult>(settings, `/api/mcp-servers/${serverId}/invoke`, {
          method: "POST",
          body: JSON.stringify({ kind, name: kind === "resource" ? (entry.uri ?? entry.name) : entry.name, args: parsed, project }),
        })
      )
    })
  }

  const answer = result && JSON.stringify(result.error ?? result.result, null, 2)

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
          </div>
        )}

        {invalid && <Notice tone="warn">{invalid}</Notice>}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={call}>
            <PlayIcon className="size-4" /> {busy ? "Running…" : "Run"}
          </Button>
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
