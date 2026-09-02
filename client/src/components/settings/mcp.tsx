import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  api,
  authSummary,
  mcpSubtitle,
  type McpAuthProbe,
  type McpServerDef,
  type ServerSettings,
} from "@/lib/settings"
import { Button } from "@/components/ui/button"
import {
  BookOpenIcon,
  ChevronDownIcon,
  GlobeIcon,
  KeyRoundIcon,
  PlugIcon,
  PlusIcon,
  SearchCheckIcon,
  UnplugIcon,
  WorkflowIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ErrorNote } from "@/components/error-note"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useInvalidateCatalog, useMcpServers } from "@/lib/queries/catalog"
import { useStoreSelect } from "@/lib/store"
import { FormPageHeader, PageForm, Field, FormActions, lines, pairs } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibraryImportPage, LibrarySection, saveLibraryEntry } from "./library"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { useAsyncAction } from "@/hooks/use-async-action"
import { settingsPath } from "@/lib/router"

type BuiltinKind = "web-search" | "knowledge" | "workflow"

const BUILTINS: { kind: BuiltinKind; label: string; hint: string; icon: typeof GlobeIcon }[] = [
  { kind: "web-search", label: "Web search", icon: GlobeIcon, hint: "The harness's web search + fetch tools, on the backend in Settings › Web search" },
  { kind: "knowledge", label: "Knowledge base", icon: BookOpenIcon, hint: "A per-project knowledge base the agent can read and write" },
  { kind: "workflow", label: "Workflows", icon: WorkflowIcon, hint: "Run multi-step workflows: each step is a real thread, mirrored into the calling thread as a subagent" },
]

export function McpPage() {
  const { settings } = useSettingsPage()
  const invalidate = useInvalidateCatalog()
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
  const builtins = missing.length > 0 && (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" title="Add one of the harness's own MCP servers">
            <PlusIcon className="size-4" /> Add built-in
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        {missing.map(({ kind, label, hint, icon: Icon }) => (
          <DropdownMenuItem key={kind} onClick={() => void inject(kind)} title={hint}>
            <Icon className="size-4" /> {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <LibrarySection
      meta={meta}
      items={mcpServers}
      endpoint="/api/mcp-servers"
      noun="MCP server"
      subtitle={mcpSubtitle}
      settings={settings}
      refresh={() => invalidate("mcp-servers")}
      extraActions={builtins}
      rowExtra={(s) =>
        s.type === "http" && s.auth === "oauth" ? (
          <McpConnection server={s} settings={settings} refresh={() => invalidate("mcp-servers")} />
        ) : null
      }
      // A built-in has nothing to edit — it is resolved at spawn, not stored.
      editable={(s) => s.type !== "builtin"}
    />
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
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {error && <ErrorNote error={error} className="basis-full" />}
      <Badge variant={connected ? "secondary" : "destructive"} title={state?.error ?? undefined}>
        <KeyRoundIcon /> {authSummary(server.authState)}
      </Badge>
      <Button variant="outline" size="sm" disabled={busy || waiting} onClick={() => void connect()}>
        <PlugIcon className="size-4" /> {waiting ? "Waiting…" : connected ? "Reconnect" : "Connect"}
      </Button>
      {state && state.state !== "disconnected" && (
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()} title="Revoke and forget these tokens">
          <UnplugIcon className="size-4" /> Disconnect
        </Button>
      )}
    </div>
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
  // A built-in is not editable (see McpPage); a stale link lands on the list.
  if ((entryId !== "new" && !server) || server?.type === "builtin") {
    return <Navigate to={settingsPath("mcp")} replace />
  }
  return (
    <McpForm
      server={server ?? null}
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
  settings,
  onDone,
}: {
  server: McpServerDef | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: server?.name ?? "",
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
          ? { type: "http", name: form.name, url: form.url, headers: pairs(form.headers, ":"), auth }
          : {
              type: "stdio",
              name: form.name,
              command: form.command,
              args: lines(form.args),
              env: pairs(form.env, "="),
            }
      await saveLibraryEntry(settings, "/api/mcp-servers", server?.id, payload)
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={server ? `Edit ${server.name}` : "New MCP server"}
        description="Define how projects connect to this MCP server."
        onBack={() => onDone(false)}
      />
      <PageForm onSubmit={save}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint="How the agent addresses the server.">
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Transport">
          <Select value={form.type} onValueChange={(type) => set({ type: (type as "stdio" | "http") ?? "stdio" })}>
            <SelectTrigger className="w-full">
              <SelectValue>{form.type === "http" ? "HTTP" : "stdio"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">HTTP</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {form.type === "http" ? (
        <>
          <Field
            label="URL"
            hint="Check asks the server how it authenticates — a server that answers 401 is stored as OAuth and can be connected from the list."
          >
            <div className="flex items-start gap-2">
              <Input
                value={form.url}
                onChange={(e) => set({ url: e.target.value, auth: "none" })}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono text-xs"
                required
              />
              <Button
                type="button"
                variant="outline"
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
      <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
