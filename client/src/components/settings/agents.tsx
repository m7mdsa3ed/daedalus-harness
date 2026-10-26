/* ── Settings › Agents ──
   The registry, and the one place a runtime's spawn command can be changed.

   Only the user's half of a row is editable — name, command, args, env — which
   is exactly the half the seed rules already promise never to overwrite, so an
   edit here survives every future release. The declarative fields beside them
   (which knobs are live, which door the instructions take, how to read a quota) are
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
import { Navigate, useNavigate, useParams } from "react-router"
import { CopyIcon, Cpu, DownloadIcon, EraserIcon, PencilIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react"
import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/busy-button"
import { useTableFilter } from "@/lib/use-table-filter"
import { DataTable, TitleCell, type DataTableExpand, type DataTableMobile, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { AgentEnvEditor } from "./agent-env"
import { AgentIcon } from "@/components/entity-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { ErrorNote } from "@/components/error-note"
import { useAsyncAction } from "@/hooks/use-async-action"
import { clearAgentOptions, dropAgentOptionsFor } from "@/lib/agent-options"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { api, profileSupports, type AgentDef, type AgentStatus } from "@/lib/settings"
import { useAgentsStatus, useInvalidateProfileCatalog, useAgents, useProfiles } from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { writeClipboard } from "@/lib/clipboard"
import { settingsFormPath, settingsPath } from "@/lib/router"
import {
  Field,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  Group,
  PageForm,
  PageHeader,
  Row,
  Section,
  StatStrip,
  StatusBadge,
  lines,
} from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

export function AgentsPage() {
  const meta = sectionMeta("agents")
  const { settings } = useSettingsPage()
  const profiles = useProfiles()
  const agents = useAgents()
  const { status, loading, error, refresh } = useAgentsStatus()
  const navigate = useNavigate()
  const [checking, setChecking] = React.useState(false)
  const [installing, setInstalling] = React.useState<ReadonlySet<string>>(() => new Set())
  const byAgent = React.useMemo(
    () => new Map((status?.agents ?? []).map((s) => [s.agentId, s])),
    [status],
  )
  const usesByAgent = React.useMemo(
    () => new Map(agents.map((a) => [a.id, profiles.filter((p) => profileSupports(p, a.id)).length])),
    [agents, profiles],
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

  /* Both halves of the option cache: the server's probe rows and this
     device's store. Clearing one alone is undone by the other on the next ask. */
  const clearOptions = async () => {
    try {
      await api(settings, "/api/agent-options", { method: "DELETE" })
      clearAgentOptions()
      toast.success("Cached agent options cleared")
    } catch (err) {
      reportError(err, "Couldn't clear the cached options")
    }
  }

  /* The install line, run on the server. Installing and updating are one
     command; a finished run re-checks, which is what replaces the badges. */
  const install = async (agent: AgentDef, update: boolean) => {
    if (installing.has(agent.id)) return
    setInstalling((s) => new Set(s).add(agent.id))
    try {
      await api(settings, `/api/agents/${agent.id}/install`, { method: "POST" })
      toast.success(`${agent.name} ${update ? "updated" : "installed"}`)
      await recheck()
    } catch (err) {
      reportError(err, `Couldn't install ${agent.name}`)
    } finally {
      setInstalling((s) => {
        const next = new Set(s)
        next.delete(agent.id)
        return next
      })
    }
  }

  /* The handlers read the latest of the page through one ref, so the table's
     memoised actions are rebuilt only when a reading changes. */
  const live = React.useRef({ install, navigate })
  React.useLayoutEffect(() => {
    live.current = { install, navigate }
  })

  const f = useTableFilter(agents, {
    text: (agent) => `${agent.name} ${agent.id} ${agent.command ?? ""}`,
    placeholder: "Search runtimes…",
    fields: [
      {
        id: "state",
        label: "Status",
        of: (agent) => {
          const s = byAgent.get(agent.id)
          return !s ? undefined : s.installed && !s.error ? "Installed" : s.installed ? "Not responding" : "Not installed"
        },
      },
    ],
  })

  const pending = loading || checking
  const columns = React.useMemo<ColumnDef<AgentDef, unknown>[]>(
    () => [
      {
        id: "agent",
        header: "Agent",
        meta: { title: true, className: "min-w-56" },
        cell: ({ row }) => {
          const command = commandLine(row.original)
          return (
            <TitleCell
              title={row.original.name}
              subtitle={
                <span className="font-mono text-xs" title={command}>
                  {command}
                </span>
              }
            />
          )
        },
      },
      {
        id: "version",
        header: "Version",
        meta: { className: "hidden @panel-md:table-cell w-32" },
        cell: ({ row }) => {
          const s = byAgent.get(row.original.id)
          return s?.installed && !s.error ? (
            <span className="font-mono">{s.agent?.version ? `v${s.agent.version}` : "unknown"}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        },
      },
      {
        id: "profiles",
        header: "Profiles",
        meta: { className: "hidden @panel-lg:table-cell w-24" },
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">{usesByAgent.get(row.original.id) ?? 0}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        meta: { align: "end", className: "w-px whitespace-nowrap" },
        cell: ({ row }) => (
          <div className="flex flex-wrap justify-end gap-1">
            <StatusBadges
              status={byAgent.get(row.original.id)}
              pending={pending}
              busy={installing.has(row.original.id)}
            />
          </div>
        ),
      },
    ],
    [byAgent, usesByAgent, pending, installing],
  )

  const actions = React.useMemo<TableAction<AgentDef>[]>(
    () => [
      {
        id: "install",
        label: "Install",
        icon: <DownloadIcon />,
        tone: "primary",
        hidden: (a) => {
          const s = byAgent.get(a.id)
          return !s || !s.install || s.installed
        },
        onClick: (a) => void live.current.install(a, false),
      },
      {
        id: "update",
        label: "Update",
        icon: <DownloadIcon />,
        tone: "primary",
        hidden: (a) => {
          const s = byAgent.get(a.id)
          return !s || !s.install || !outdated(s)
        },
        onClick: (a) => void live.current.install(a, true),
      },
      { id: "edit", label: "Edit", icon: <PencilIcon />, onClick: (a) => void live.current.navigate(settingsFormPath("agents", a.id)) },
    ],
    [byAgent],
  )

  const expand = React.useMemo<DataTableExpand<AgentDef>>(
    () => ({
      render: (agent) => (
        <AgentDetail agent={agent} status={byAgent.get(agent.id)} uses={usesByAgent.get(agent.id) ?? 0} />
      ),
    }),
    [byAgent, usesByAgent],
  )

  const mobile = React.useMemo<DataTableMobile<AgentDef>>(
    () => ({
      renderRow: (agent) => {
        const status = byAgent.get(agent.id)
        return (
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
              <AgentIcon agentId={agent.id} className="size-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="truncate text-sm font-medium">{agent.name}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">{commandLine(agent)}</div>
              <div className="flex flex-wrap gap-1">
                <StatusBadges status={status} pending={pending} busy={installing.has(agent.id)} showVersion />
              </div>
              {status && (!status.installed || status.error) && (
                <div className="text-xs text-muted-foreground">
                  <StatusLine status={status} />
                </div>
              )}
            </div>
          </div>
        )
      },
    }),
    [byAgent, pending, installing],
  )

  /* The strip's numbers are the measured ones; until the first answer they are
     dashes rather than zeroes, which would read as "nothing installed". */
  const readings = status?.agents ?? []
  const ready = readings.filter((s) => s.installed && !s.error).length
  const broken = readings.filter((s) => !s.installed || s.error).length
  const updates = readings.filter(outdated).length
  const dash = (n: number) => (status ? String(n) : "—")

  return (
    <>
      <PageHeader
        meta={meta}
        facts={
          status ? (
            <span>
              Harness speaks ACP protocol v{status.acp.protocolVersion} through SDK{" "}
              <span className="font-mono">{status.acp.sdkVersion}</span>
              {" · "}checked {new Date(Math.max(...status.agents.map((s) => s.checkedAt), 0)).toLocaleTimeString()}
            </span>
          ) : loading ? (
            <span>Checking which agents are installed…</span>
          ) : null
        }
        action={
          <>
            <Button
              variant="outline"
              title="Forget every agent's probed models, modes and options; each is asked again on next use"
              onClick={() => void clearOptions()}
            >
              <EraserIcon data-icon="inline-start" />
              Clear cached options
            </Button>
            <Button variant="outline" loading={checking} onClick={() => void recheck()}>
              <RefreshCwIcon data-icon="inline-start" />
              Check again
            </Button>
          </>
        }
      />
      <StatStrip
        stats={[
          { label: "Registered", value: String(agents.length) },
          { label: "Ready", value: dash(ready), tone: "ok" },
          { label: "Needs attention", value: dash(broken), tone: broken > 0 ? "bad" : "default" },
          { label: "Updates", value: dash(updates) },
        ]}
      />
      {error && (
        <Section>
          <ErrorNote error={inlineFromQuery(error, "Couldn't check the agents")} />
        </Section>
      )}
      {agents.length === 0 && !loading ? (
        <Empty size="lg" icon={Cpu}>
          The server has no agents registered.
        </Empty>
      ) : (
        <Section>
        <DataTable
          columns={columns}
          data={f.rows}
          getRowId={(a) => a.id}
          isLoading={agents.length === 0 && loading}
          pageSize={50}
          mark={(a) => <AgentIcon agentId={a.id} className="size-5" />}
          actions={actions}
          expand={expand}
          mobile={mobile}
          emptyIcon={<Cpu />}
          emptyMessage={f.narrowed ? undefined : "No runtimes."}
          filtering={f.filtering}
        />
        </Section>
      )}
    </>
  )
}

const commandLine = (agent: AgentDef) =>
  agent.command ? [agent.command, ...(agent.args ?? [])].join(" ") : "—"

/* ── One agent's reading, in badges ──
   Installed: one calm badge, the protocol it answered with and, when npm
   knows a newer one, what is available. Not installed: one red badge, and
   the detail says what is missing and how to get it. Present but silent:
   the handshake's own error, in the badge's title and in the detail. The
   version is its own column on a wide panel; `showVersion` puts it back in
   the badges where there is no column (the phone). */
function StatusBadges({
  status,
  pending,
  busy,
  showVersion = false,
}: {
  status: AgentStatus | undefined
  pending: boolean
  busy: boolean
  showVersion?: boolean
}) {
  if (busy) return <StatusBadge tone="info">Running…</StatusBadge>
  if (!status) {
    return pending ? <StatusBadge>Checking…</StatusBadge> : null
  }
  if (!status.installed) return <StatusBadge tone="bad">Not installed</StatusBadge>
  if (status.error) {
    return (
      <span title={status.error}>
        <StatusBadge tone="bad">Not answering</StatusBadge>
      </span>
    )
  }
  const agentName = status.agent?.name ?? undefined
  return (
    <>
      <span title={agentName}>
        {showVersion ? (
          <StatusBadge dot={false}>{status.agent?.version ? `v${status.agent.version}` : "version unknown"}</StatusBadge>
        ) : (
          <StatusBadge tone="ok">Installed</StatusBadge>
        )}
      </span>
      {outdated(status) && <StatusBadge tone="info" dot={false}>v{status.latest} available</StatusBadge>}
      {status.protocolVersion !== null && <StatusBadge dot={false}>ACP v{status.protocolVersion}</StatusBadge>}
    </>
  )
}

/* "Newer exists" is a *difference*, not a comparison: the published version is
   npm's `latest` tag, which is by definition the one to be on, so anything
   else — behind, a prerelease, a local build — is worth saying. Ordering two
   version strings would be a semver parser we would then have to be right
   about. A `latest` of null is "not askable" and says nothing. */
const outdated = (status: AgentStatus) =>
  status.installed && !!status.latest && !!status.agent?.version && status.latest !== status.agent.version

/* The install command with a copy button — the command is the server's to
   run, not the browser's, so it is offered as text here and run only by the
   row's Install action. */
function InstallLine({ install }: { install: string }) {
  const copy = (text: string) => {
    writeClipboard(text)
      .then(() => toast.success("Install command copied"))
      .catch((err) => reportError(err, "Couldn't copy the command"))
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono break-all text-foreground">{install}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="pointer-coarse:size-11"
        title="Copy the install command"
        aria-label="Copy the install command"
        onClick={() => copy(install)}
      >
        <CopyIcon className="size-3.5" />
      </Button>
    </div>
  )
}

/* What went wrong, if anything: nothing for a healthy agent beyond where it
   was found; for a missing one, what was not found and the install line. */
function StatusLine({ status }: { status: AgentStatus }) {
  if (status.installed && !status.error) {
    return status.path ? <div className="mt-0.5 truncate font-mono text-muted-foreground">{status.path}</div> : null
  }
  return (
    <div className="mt-1 space-y-1">
      {!status.installed && (
        <div className="text-destructive">
          <span className="font-mono">{status.missing}</span> was not found on the server.
        </div>
      )}
      {status.error && <div className="text-destructive">{status.error}</div>}
      {!status.installed && status.install && <InstallLine install={status.install} />}
    </div>
  )
}

/* The row's opened detail (desktop): who it is, where the binary was found,
   what was wrong with it, and the line that installs it. */
function AgentDetail({
  agent,
  status,
  uses,
}: {
  agent: AgentDef
  status: AgentStatus | undefined
  uses: number
}) {
  return (
    <div className="grid gap-x-8 gap-y-3 py-1 text-sm @panel-md:grid-cols-[auto_minmax(0,1fr)]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">ID</dt>
        <dd className="truncate font-mono">{agent.id}</dd>
        <dt className="text-muted-foreground">Profiles</dt>
        <dd>{uses}</dd>
        {status?.installed && status.path && (
          <>
            <dt className="text-muted-foreground">Found at</dt>
            <dd className="truncate font-mono" title={status.path}>
              {status.path}
            </dd>
          </>
        )}
      </dl>
      <div className="min-w-0 space-y-1.5">
        {status && (!status.installed || status.error) && <StatusLine status={status} />}
        {status?.install && (status.installed || status.error) && (
          <div className="space-y-1">
            <div className="text-muted-foreground">Install command</div>
            <InstallLine install={status.install} />
          </div>
        )}
        {!status && <span className="text-muted-foreground">No reading yet.</span>}
      </div>
    </div>
  )
}

export function AgentFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const agents = useAgents()
  const agent = agents.find((a) => a.id === entryId)
  if (!agent) return <Navigate to={settingsPath("agents")} replace />
  return <AgentForm agent={agent} onClose={() => void navigate(settingsPath("agents"))} />
}

function AgentForm({ agent, onClose }: { agent: AgentDef; onClose: () => void }) {
  const { settings } = useSettingsPage()
  const invalidateProfile = useInvalidateProfileCatalog()
  const [form, setForm] = React.useState({
    name: agent.name,
    command: agent.command ?? "",
    args: (agent.args ?? []).join("\n"),
    install: agent.install ?? "",
    icon: agent.icon ?? "",
  })
  /* The env is its own state, as the record it is on the wire: the editor splits
     it three ways and hands back the merged whole, and round-tripping it through
     a `NAME=value` string on every keystroke is exactly the format this replaced.
     `envProblem` is the editor's own verdict on the rows (a bad name, a
     duplicate) — the save is refused on it rather than sending a row the server
     would silently prune. */
  const [env, setEnv] = React.useState<Record<string, string>>(() => ({ ...(agent.env ?? {}) }))
  const [envProblem, setEnvProblem] = React.useState(false)
  /* What this runtime ships, so the editor can tell the profile's wiring from a
     person's keys. An agent somebody added has no baseline, and then every key is
     theirs — which is the honest reading, not a special case. */
  const seededEnv = agent.seededEnv ?? {}
  /* The switches, in their own state: they are not text and must not round-trip
     through the env box. A switch with no stored value is the runtime's
     `fallback`, which is what an untouched one means — so the map holds only
     what somebody changed, and Save sends exactly that. */
  const switches = agent.behavior?.switches ?? []
  const [values, setValues] = React.useState<Record<string, boolean>>(() => ({ ...(agent.behavior?.values ?? {}) }))
  const isOn = (entry: (typeof switches)[number]) => values[entry.key] ?? entry.fallback
  const setSwitch = (key: string, on: boolean) => setValues((v) => ({ ...v, [key]: on }))
  const { busy, error, run } = useAsyncAction()
  const confirm = useConfirm()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  /* The jump bar: at most four stops, because the app's one segmented control
     stops being readable past about five. Defaults is deliberately not one of
     them — it is a single button at the foot of the page, not a place anybody
     navigates to twice — while the three below are where the editing happens. */
  const formSections = React.useMemo(
    () =>
      [
        { id: "launch", label: "Launch" },
        { id: "environment", label: "Environment" },
        ...(switches.length > 0 ? [{ id: "behavior", label: "Behaviour" }] : []),
        { id: "appearance", label: "Install and icon" },
      ],
    [switches.length],
  )

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
    /* Refused, not truncated: `recordFromRows` would drop a malformed name and
       the save would say "saved" about a variable that no longer exists. */
    if (envProblem) {
      toast.error("Fix the environment first", {
        description: "A variable name or a duplicate has to be corrected before this can be saved.",
      })
      return
    }
    void run("Couldn't save the agent", async () => {
      const updated = await api<AgentDef>(settings, `/api/agents/${agent.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: form.name,
          command: form.command,
          args: lines(form.args),
          env,
          /* Empty means "none", not "leave it": both are cleared on the row
             the same way, and a blank field that quietly kept the old value is
             how an edit stops being an edit. */
          install: form.install.trim() || null,
          icon: form.icon.trim() || null,
          /* Only the values: what the switches *are* is the seed's, and a form
             that could rename them would be redefining the runtime. */
          behaviorValues: values,
        }),
      })
      await applied(updated, "Agent saved")
    })
  }

  /* Reset throws away whatever the user put in the form, and there is no
     undo — the row is the only copy. Every other irreversible write in the app
     asks first, and this one asks harder than most, because the button sits in
     the same footer as Save and the two are one slip apart. */
  const reset = async () => {
    const ok = await confirm({
      title: `Reset ${agent.name} to its default?`,
      description:
        "The command, arguments, environment, behaviour switches, install line and icon this agent ships with come back, and whatever you have set here is lost. Threads already running keep the process they have.",
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
    <>
      <FormPageHeader
        title={`Edit ${agent.name}`}
        description={`How the server launches ${agent.id}. Threads already running keep the process they have; the change applies the next time one spawns.`}
        onBack={onClose}
      />
      <PageForm onSubmit={save}>
        <FormShell sections={formSections}>
        <FormSection id="launch" label="Launch" hint="The command the server spawns.">
          <Field label="Name" hint="What the pickers call it.">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required />
          </Field>
          <Field label="Command" hint="A binary on PATH, or an absolute path.">
            <Input
              value={form.command}
              onChange={(e) => set({ command: e.target.value })}
              className="font-mono"
              required
            />
          </Field>
          <Field label="Arguments" hint="One per line. {placeholders} are filled at spawn.">
            <Textarea
              value={form.args}
              onChange={(e) => set({ args: e.target.value })}
              rows={2}
              className="font-mono"
            />
          </Field>
        </FormSection>
        {/* Its own section, because it is now three kinds of thing rather than
            one box of text (see `agent-env.tsx`). The seeded env is what lets
            the editor tell a key the profile drives from one a person typed. */}
        <FormSection
          id="environment"
          label="Environment"
          hint="What the process is given at spawn. Applied at spawn — a thread already running keeps the process it has."
        >
          <AgentEnvEditor
            env={env}
            seeded={seededEnv}
            onChange={(next, problems) => {
              setEnv(next)
              setEnvProblem(problems.any)
            }}
          />
        </FormSection>
        {/* Descriptive, not protocol — which is why these two are editable
            at all and the declarative fields beside them are not. An agent
            somebody added has no seed to inherit either from: without them a
            row measured as missing showed no way to fix it, and every
            non-built-in wore the same neutral glyph. */}
        {/* Before the descriptive half, and after the environment: these are
            what the runtime *does*, where the fields above are how it is
            launched. */}
        {switches.length > 0 && (
          <FormSection
            id="behavior"
            label="Behaviour"
            hint="What this agent does, rather than how it is launched. Applied at spawn — a thread already running keeps the process it has."
          >
            <Group>
              {switches.map((entry) => (
                <Row key={entry.key} title={entry.label} subtitle={entry.description}>
                  <Switch
                    checked={isOn(entry)}
                    onCheckedChange={(next) => setSwitch(entry.key, next)}
                    aria-label={entry.label}
                  />
                </Row>
              ))}
            </Group>
          </FormSection>
        )}
        <FormSection id="appearance" label="Install and icon" hint="Descriptive only; the protocol never reads them.">
          <Field label="Install command" hint="Shown when the binary is not on the server's PATH.">
            <Input
              value={form.install}
              onChange={(e) => set({ install: e.target.value })}
              className="font-mono"
              placeholder="npm install -g …"
            />
          </Field>
          <Field label="Icon" hint="An image URL or data: URI. app = the harness's own mark.">
            <Input
              value={form.icon}
              onChange={(e) => set({ icon: e.target.value })}
              className="font-mono"
              placeholder="https://… or data:image/png;base64,…"
            />
          </Field>
        </FormSection>
        {agent.builtIn && (
          <FormSection id="reset" label="Defaults" hint="Put this agent back the way it ships.">
            <Button
              type="button"
              variant="outline"
              className="pointer-coarse:h-11"
              disabled={busy}
              onClick={() => void reset()}
            >
              <RotateCcwIcon data-icon="inline-start" /> Reset to default
            </Button>
          </FormSection>
        )}
        </FormShell>
        <FormActions busy={busy} onCancel={onClose} error={error} />
      </PageForm>
    </>
  )
}
