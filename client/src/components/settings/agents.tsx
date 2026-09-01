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
   in front of you is worse than one that does nothing at all. */
import * as React from "react"
import { Cpu, PencilIcon, RotateCcwIcon } from "lucide-react"
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
import { api, profileSupports, type AgentDef } from "@/lib/settings"
import { useInvalidateProfileCatalog, useAgents, useProfiles } from "@/lib/queries/catalog"
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
  const [editing, setEditing] = React.useState<AgentDef | null>(null)

  return (
    <>
      <PageHeader meta={meta} />
      {agents.length === 0 ? (
        <EmptyCard icon={Cpu} text="The server has no agents registered." />
      ) : (
        <Group>
          {agents.map((agent) => {
            const uses = profiles.filter((p) => profileSupports(p, agent.id)).length
            return (
              <Row
                key={agent.id}
                icon={<AgentIcon agentId={agent.id} className="size-5" />}
                title={agent.name}
                subtitle={
                  <span className="font-mono">
                    {agent.id}
                    {agent.command ? ` · ${[agent.command, ...(agent.args ?? [])].join(" ")}` : ""}
                  </span>
                }
              >
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
