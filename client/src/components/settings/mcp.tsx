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
import { api, mcpSubtitle, type McpServerDef, type ServerSettings } from "@/lib/settings"
import { Button } from "@/components/ui/button"
import { BookOpenIcon, GlobeIcon } from "lucide-react"
import { useStore } from "@/lib/store"
import { FormPageHeader, PageForm, Field, FormActions, lines, pairs } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibraryImportPage, LibrarySection, saveLibraryEntry } from "./library"
import { reportError } from "@/lib/errors"
import { settingsPath } from "@/lib/router"

export function McpPage() {
  const { settings, actions } = useSettingsPage()
  const meta = sectionMeta("mcp")
  const { state } = useStore()

  /* The harness's own two servers, added with one press rather than typed in:
     there is nothing to type — the row is a handle, and the command, env and
     credentials are synthesized at spawn. Idempotent server-side (fixed id),
     and hidden once present, since a second copy is the same row. */
  const has = (kind: "web-search" | "knowledge") =>
    state.mcpServers.some((s) => s.type === "builtin" && s.builtin === kind)
  const inject = async (kind: "web-search" | "knowledge") => {
    try {
      await api(settings, `/api/mcp-servers/builtin/${kind}`, { method: "POST" })
      await actions.refreshMcpServers()
    } catch (err) {
      reportError(err, `Couldn't add the ${kind} server`)
    }
  }
  const builtins = (
    <>
      {!has("web-search") && (
        <Button variant="outline" onClick={() => void inject("web-search")} title="The harness's web search + fetch tools, on the backend in Settings › Web search">
          <GlobeIcon className="size-4" /> Add web search
        </Button>
      )}
      {!has("knowledge") && (
        <Button variant="outline" onClick={() => void inject("knowledge")} title="A per-project knowledge base the agent can read and write">
          <BookOpenIcon className="size-4" /> Add knowledge base
        </Button>
      )}
    </>
  )

  return (
    <LibrarySection
      meta={meta}
      items={state.mcpServers}
      endpoint="/api/mcp-servers"
      noun="MCP server"
      subtitle={mcpSubtitle}
      settings={settings}
      refresh={actions.refreshMcpServers}
      extraActions={builtins}
      // A built-in has nothing to edit — it is resolved at spawn, not stored.
      editable={(s) => s.type !== "builtin"}
    />
  )
}

export function McpImportPage() {
  const { actions } = useSettingsPage()
  return <LibraryImportPage meta={sectionMeta("mcp")} kind="mcpServers" endpoint="/api/mcp-servers" noun="MCP server" refresh={actions.refreshMcpServers} />
}

export function McpFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings, actions } = useSettingsPage()
  const { state } = useStore()
  const server = entryId === "new" ? null : state.mcpServers.find((item) => item.id === entryId)
  // A built-in is not editable (see McpPage); a stale link lands on the list.
  if ((entryId !== "new" && !server) || server?.type === "builtin") {
    return <Navigate to={settingsPath("mcp")} replace />
  }
  return (
    <McpForm
      server={server ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await actions.refreshMcpServers()
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
  }))
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const payload =
        form.type === "http"
          ? { type: "http", name: form.name, url: form.url, headers: pairs(form.headers, ":") }
          : {
              type: "stdio",
              name: form.name,
              command: form.command,
              args: lines(form.args),
              env: pairs(form.env, "="),
            }
      await saveLibraryEntry(settings, "/api/mcp-servers", server?.id, payload)
      onDone(true)
    } catch (err) {
      reportError(err, "Couldn't save the MCP server")
      setBusy(false)
    }
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
          <Field label="URL">
            <Input
              value={form.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
              className="font-mono text-xs"
              required
            />
          </Field>
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
      <FormActions busy={busy} onCancel={() => onDone(false)} />
      </PageForm>
    </>
  )
}
