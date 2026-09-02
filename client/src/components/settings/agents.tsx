/* ── Settings › Agents ──
   The registry, and the one place a runtime's spawn command can be changed.

   Only the user's half of a row is editable — name, command, args, env — which
   is exactly the half the seed rules already promise never to overwrite, so an
   edit here survives every future release. The declarative fields beside them
   (which knobs are live, which door a persona takes, how to read a quota) are
   statements about what the protocol on the other end can do rather than
   preferences, so they stay the server's and are not drawn.

   Nothing here touches a running thread: the process it holds was spawned with
   the old command, and an edit reaches it at its next spawn — which the form
   says out loud, because a settings page that silently does nothing to what is
   in front of you is worse than one that does nothing at all.

   Each row also says whether its binary is actually on the server, and what
   answered (`useAgentsStatus`, one ACP handshake per agent, server-cached).
   A row is a contract with a binary somebody else ships, and until this the
   first place a missing one showed was an ENOENT inside a thread — the page
   that lists the row is where "not installed" belongs, next to the line that
   installs it. Versions are what the agent reports over ACP (`agentInfo`),
   not a `--version` flag parsed per CLI, so every runtime reads the same. */
import * as React from "react"
import { CopyIcon, Cpu, PencilIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { AgentIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { ErrorNote } from "@/components/error-note"
import { useAsyncAction } from "@/hooks/use-async-action"
import { dropAgentOptionsFor } from "@/lib/agent-options"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { api, profileSupports, type AgentDef, type AgentStatus } from "@/lib/settings"
import { useAgentsStatus, useInvalidateProfileCatalog, useAgents, useProfiles } from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { PageHeader, Group, Row, EmptyCard, Field, lines } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/* ── `NAME=value` lines ⇄ the env record ──
   Split on the first `=` only: a value is a JSON blob or a config template, and
   both are full of them.

   Two rules the naive version got wrong, and both of them silently. A **value
   may contain newlines** — nothing stops a user pasting a multi-line config
   into `CODEX_CONFIG`, and the seeded one is only single-line by luck — so a
   line with no `=` in it is a *continuation* of the value above, not a line to
   drop; dropping it truncated the value and the form said nothing. And a line
   before any `NAME=` at all is the one case with nothing to continue, which is
   the only thing here that is genuinely discarded. `lines()` is not used for
   the same reason: it trims, and leading whitespace is part of a wrapped
   value. */
const envText = (env: Record<string, string> | undefined) =>
  Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")

/** A `NAME=` at the start of a line, and nothing else, opens a new value. */
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*=/

const envRecord = (text: string): Record<string, string> => {
  const env: Record<string, string> = {}
  let current: string | null = null
  for (const line of text.split("\n")) {
    if (ENV_LINE.test(line)) {
      const at = line.indexOf("=")
      current = line.slice(0, at)
      env[current] = line.slice(at + 1)
    } else if (current !== null) {
      env[current] += `\n${line}`
    }
  }
  /* A blank line is a separator, not the last line of the value above it: it
     is how a textarea ends, and how anyone spaces out a list of keys. The cost
     is that a value cannot end in a blank line, which nothing needs. */
  for (const name of Object.keys(env)) env[name] = env[name].replace(/\n+$/, "")
  return env
}

export function AgentsPage() {
  const meta = sectionMeta("agents")
  const profiles = useProfiles()
  const agents = useAgents()
  const { status, loading, error, refresh } = useAgentsStatus()
  const [editing, setEditing] = React.useState<AgentDef | null>(null)
  const [checking, setChecking] = React.useState(false)
  const byAgent = React.useMemo(
    () => new Map((status?.agents ?? []).map((s) => [s.agentId, s])),
    [status],
  )

  /* A re-check spawns every agent once; the button says so while it does. */
  const recheck = async () => {
    setChecking(true)
    try {
      await refresh()
    } catch (err) {
      reportError(err, "Couldn't check the agents")
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <PageHeader
        meta={meta}
        action={
          <Button variant="outline" size="sm" disabled={checking} onClick={() => void recheck()}>
            <RefreshCwIcon className={`size-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking…" : "Check again"}
          </Button>
        }
      />
      <p className="-mt-3 mb-4 text-xs text-muted-foreground">
        {status ? (
          <>
            Harness speaks ACP protocol v{status.acp.protocolVersion} through SDK{" "}
            <span className="font-mono">{status.acp.sdkVersion}</span>
            {" · "}checked {new Date(Math.max(...status.agents.map((s) => s.checkedAt), 0)).toLocaleTimeString()}
          </>
        ) : loading ? (
          "Checking which agents are installed…"
        ) : null}
      </p>
      <ErrorNote error={inlineFromQuery(error, "Couldn't check the agents")} />
      {agents.length === 0 ? (
        <EmptyCard icon={Cpu} text="The server has no agents registered." />
      ) : (
        <Group>
          {agents.map((agent) => {
            const uses = profiles.filter((p) => profileSupports(p, agent.id)).length
            const st = byAgent.get(agent.id)
            return (
              <Row
                key={agent.id}
                icon={<AgentIcon agentId={agent.id} className="size-5" />}
                title={agent.name}
                subtitle={
                  <>
                    <span className="font-mono">
                      {agent.id}
                      {agent.command ? ` · ${[agent.command, ...(agent.args ?? [])].join(" ")}` : ""}
                    </span>
                    {st && <StatusLine status={st} />}
                  </>
                }
              >
                <StatusBadges status={st} pending={loading || checking} />
                <Badge variant="secondary">
                  {uses} profile{uses === 1 ? "" : "s"}
                </Badge>
                <Button variant="ghost" size="sm" onClick={() => setEditing(agent)}>
                  <PencilIcon className="size-4" /> Edit
                </Button>
              </Row>
            )
          })}
        </Group>
      )}
      {editing && <AgentDialog agent={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/* ── One agent's reading, in badges ──
   Installed: the version the agent reported and the protocol it answered
   with. Not installed: one red badge, and the sentence below the row says
   what is missing and how to get it. Present but silent: the handshake's
   own error, in the badge's title and in the line below. */
function StatusBadges({ status, pending }: { status: AgentStatus | undefined; pending: boolean }) {
  if (!status) {
    return pending ? <Badge variant="outline">Checking…</Badge> : null
  }
  if (!status.installed) return <Badge variant="destructive">Not installed</Badge>
  if (status.error) {
    return (
      <Badge variant="destructive" title={status.error}>
        Not answering
      </Badge>
    )
  }
  return (
    <>
      <Badge variant="secondary" title={status.agent?.name ?? undefined}>
        {status.agent?.version ? `v${status.agent.version}` : "version unknown"}
      </Badge>
      {status.protocolVersion !== null && <Badge variant="outline">ACP v{status.protocolVersion}</Badge>}
    </>
  )
}

/* The line under the command. Nothing for a healthy agent beyond where it
   was found; for a missing one, the install command with a copy button —
   the command is the server's to run, not the browser's, so it is offered as
   text rather than as a button that runs `npm install -g` on somebody's box. */
function StatusLine({ status }: { status: AgentStatus }) {
  if (status.installed && !status.error) {
    return status.path ? <div className="mt-0.5 truncate font-mono opacity-70">{status.path}</div> : null
  }
  const copy = (text: string) => {
    writeClipboard(text)
      .then(() => toast.success("Install command copied"))
      .catch((err) => reportError(err, "Couldn't copy the command"))
  }
  return (
    <div className="mt-1 space-y-1">
      {!status.installed && (
        <div className="text-destructive">
          <span className="font-mono">{status.missing}</span> was not found on the server.
        </div>
      )}
      {status.error && <div className="text-destructive">{status.error}</div>}
      {!status.installed && status.install && (
        <div className="flex items-center gap-1.5">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{status.install}</code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title="Copy the install command"
            onClick={() => copy(status.install!)}
          >
            <CopyIcon className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

function AgentDialog({ agent, onClose }: { agent: AgentDef; onClose: () => void }) {
  const { settings } = useSettingsPage()
  const invalidateProfile = useInvalidateProfileCatalog()
  const [form, setForm] = React.useState({
    name: agent.name,
    command: agent.command ?? "",
    args: (agent.args ?? []).join("\n"),
    env: envText(agent.env),
  })
  const { busy, error, run } = useAsyncAction()
  const confirm = useConfirm()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  /* Both writes end the same way: the server's probe cache is evicted for this
     agent on its side, and the device-local option store on ours — the answers
     in it were a function of the env that just changed. */
  const applied = async (updated: AgentDef, message: string) => {
    dropAgentOptionsFor(agent.id)
    await invalidateProfile()
    toast.success(message, { description: updated.name })
    onClose()
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void run("Couldn't save the agent", async () => {
      const updated = await api<AgentDef>(settings, `/api/agents/${agent.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: form.name,
          command: form.command,
          args: lines(form.args),
          env: envRecord(form.env),
        }),
      })
      await applied(updated, "Agent saved")
    })
  }

  /* Reset throws away whatever the user put in the four fields, and there is no
     undo — the row is the only copy. Every other irreversible write in the app
     asks first, and this one asks harder than most, because the button sits in
     the same footer as Save and the two are one slip apart. */
  const reset = async () => {
    const ok = await confirm({
      title: `Reset ${agent.name} to its default?`,
      description:
        "The command, arguments and environment this agent ships with come back, and whatever you have set here is lost. Threads already running keep the process they have.",
      confirmLabel: "Reset",
      destructive: true,
    })
    if (!ok) return
    await run("Couldn't restore the agent", async () => {
      const restored = await api<AgentDef>(settings, `/api/agents/${agent.id}/reset`, { method: "POST" })
      await applied(restored, "Agent restored to its default")
    })
  }

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <form onSubmit={save} className="space-y-4">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Edit {agent.name}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              How the server launches <span className="font-mono">{agent.id}</span>. Threads already
              running keep the process they have; the change applies the next time one spawns.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What the pickers call it.">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
            </Field>
            <Field label="Command" hint="A binary on PATH, or an absolute path.">
              <Input
                value={form.command}
                onChange={(e) => set({ command: e.target.value })}
                className="font-mono text-xs"
                required
              />
            </Field>
          </div>

          <Field label="Arguments" hint="One per line. {placeholders} are filled at spawn.">
            <Textarea
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
              rows={2}
              className="font-mono text-xs"
            />
          </Field>

          <Field
            label="Environment"
            hint="One per line: NAME=value. {apiKey} {baseUrl} {gatewayUrl} {model} {smallModel} {effort} {contextWindow} {maxOutputTokens} {cwd} {personaFile} {personaPrompt} — a key whose placeholders resolve empty is dropped."
          >
            <Textarea
              value={form.env}
              onChange={(e) => set({ env: e.target.value })}
              rows={8}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>

          <ErrorNote error={error} />

          <ResponsiveDialogFooter>
            {agent.builtIn && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void reset()}
                className="sm:mr-auto"
                title="Put this agent back the way it ships"
              >
                <RotateCcwIcon className="size-4" /> Reset to default
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
import { writeClipboard } from "@/lib/clipboard"
