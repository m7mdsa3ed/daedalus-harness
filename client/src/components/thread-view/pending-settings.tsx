/* ── The settings change this thread is carrying ──
   A reading of the thread like the ones beside it — but about what the thread
   is *about to be* on rather than what it is doing, so it belongs with the
   conversation it is about to answer, at the foot of the transcript, beside
   the queue. It used to be a reading in the composer's end cluster and a row
   in the settings menu, which put one fact in two chrome places at once; the
   transcript is where the thing it describes happens.

   **In flight outranks held**, the way `configView` reads the two: a pick the
   server has not answered is the newest statement of intent, and a change
   already staged is what that pick is about to become. Both states are drawn
   the same way for the same reason — a process-costing change is one fact
   whether it was staged for the next send or spent on the spot because a held
   turn was waiting for it. That second case used to be a toast and nothing
   else.

   The card carries the change itself, and the one thing worth doing about it —
   which exists only once the server is holding it. A pick still in flight has
   nothing to cancel yet.

   A staged tool link is part of the same `StagedConfig`, so it is named here
   too; the tools menu keeps its own header where the picks are made. */
import { useState } from "react"
import { Spinner } from "@/components/ui/spinner"
import {
  BlocksIcon,
  CheckIcon,
  ClockIcon,
  CpuIcon,
  GaugeIcon,
  RefreshCwIcon,
  LayoutGridIcon,
  PlugIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UsersIcon,
  VenetianMaskIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Actions } from "@/lib/actions"
import { configChanges, type ConfigChange } from "@/lib/actions"
import { useAgents, useCommands, useMcpServers, usePersonas, useProfiles, useSkills } from "@/lib/queries/catalog"
import { combineCosts, configCost, isCostly, type ConfigCost, type ConfigSetting } from "@/lib/config-cost"
import { reportError } from "@/lib/errors"
import { useSessionMeta, type ThreadState } from "@/lib/store"

/** The ids a tool patch names, resolved against the catalog that lists them.
    `undefined` is a field the patch did not touch; `[]` is a set emptied. */
function toolNames(items: { id: string; name: string }[], ids: string[] | undefined): string | null {
  if (ids === undefined) return null
  if (ids.length === 0) return "none"
  return ids.map((id) => items.find((item) => item.id === id)?.name ?? id).join(", ")
}

/** The glyph a changed setting wears. A stage of the agent's own options has no
    name of ours, so it takes the settings glyph rather than a per-runtime guess. */
const CHANGE_ICONS: Record<ConfigChange["kind"], typeof CpuIcon> = {
  profile: PlugIcon,
  model: CpuIcon,
  effort: GaugeIcon,
  suggestions: SparklesIcon,
  ui: LayoutGridIcon,
  persona: VenetianMaskIcon,
  helpers: UsersIcon,
  mode: ShieldIcon,
  option: SlidersHorizontalIcon,
}

/** The staged links, which are not `ConfigPatch` settings but travel in the same
    patch — drawn as tiles for the same reason. */
const LINK_ICONS = {
  mcpServerIds: BlocksIcon,
  skillIds: SparklesIcon,
  commandIds: SquareTerminalIcon,
} as const

/** The settings a change kind is priced as (`lib/config-cost.ts`). The agent's
    own mode and options are not ours to know and carry no cost. */
const COST_SETTINGS: Partial<Record<ConfigChange["kind"], ConfigSetting>> = {
  profile: "profile",
  model: "model",
  effort: "effort",
  persona: "persona",
  suggestions: "suggestions",
  ui: "ui",
  helpers: "helpers",
}

/** Whether a running turn can take this change as it is — the client's mirror of
    `steerStaged` (server/src/sessions.ts): the agent's own selectors always, a
    model/effort/profile move only where the agent row takes it live. Everything
    else is spawn text or a tool link, read once at `session/new`, so it waits
    for the next send. */
function steerable(kind: ConfigChange["kind"], takesLive: boolean): boolean {
  return kind === "mode" || kind === "option" || (takesLive && (kind === "profile" || kind === "model" || kind === "effort"))
}

function ChangeTile({ icon: Icon, label, value }: { icon: typeof CpuIcon; label: string; value: string }) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2 py-1"
      title={`${label}: ${value}`}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs text-foreground">{value}</span>
      <span className="sr-only">{label}</span>
    </div>
  )
}

export function PendingSettings({
  thread,
  sessionId,
  actions,
}: {
  thread: ThreadState
  sessionId: string
  actions: Actions
}) {
  const profiles = useProfiles()
  /* The tool catalogs, because `configChanges` speaks only for the session
     row's own settings — a staged tool link is a change this card must be able
     to name too, or a tools-only change would draw it blank. */
  const mcpServers = useMcpServers()
  const skills = useSkills()
  const commands = useCommands()
  const personas = usePersonas()
  const agents = useAgents()
  const meta = useSessionMeta(sessionId)
  const pending = thread.pendingConfig
  const held = thread.stagedConfig
  /* "Apply now" is a request this device is waiting on — and, until it lands,
     one there is nothing on the server to draw: `stagedConfig` is unchanged
     and no `pendingConfig` was ever set, because the patch was not picked here.
     So the wait is this component's own, and it reads as the same in-flight
     state a pick draws. */
  const [applyingNow, setApplyingNow] = useState(false)
  /* One card per thread, so a pick that has not landed yet supersedes the
     staged change it is about to become rather than stacking beside it. */
  const patch = pending ?? held
  if (!patch) return null
  const applying = pending !== null || applyingNow
  const changes = configChanges(patch, profiles, thread, personas)
  const takesLive = !!agents.find((a) => a.id === meta?.agentId)?.liveConfig
  /* A running turn is steered, never restarted: only `steerable` changes are
     taken and the rest stay staged. A *held* turn is different — the server
     flushes the whole patch there, restart included — so it is not a steer. */
  const steering = thread.turnActive && !thread.paused
  const tools = [
    ...(patch.mcpServerIds !== undefined ? ["MCP"] : []),
    ...(patch.skillIds !== undefined ? ["Skills"] : []),
    ...(patch.commandIds !== undefined ? ["Commands"] : []),
  ]
  const now = steering ? changes.filter((change) => steerable(change.kind, takesLive)) : changes
  const later = steering ? [...changes.filter((change) => !steerable(change.kind, takesLive)).map((c) => c.label), ...tools] : []
  const action = steering ? "Steer now" : "Apply now"
  const canAct = !steering || now.length > 0
  /* What taking it costs, said here and not in the settings menu: the pick is
     made mid-turn, and the card is where the reader sees what it did. Only what
     this button takes is priced — a steer never restarts for the rest. */
  const cost: ConfigCost | null = thread.turnActive
    ? combineCosts([
        ...now.flatMap((change) => {
          const setting = COST_SETTINGS[change.kind]
          return setting ? [configCost(setting, takesLive)] : []
        }),
        ...(!steering && patch.mcpServerIds !== undefined ? [configCost("mcp", false)] : []),
      ])
    : null
  const links = [
    { icon: LINK_ICONS.mcpServerIds, label: "MCP", value: toolNames(mcpServers, patch.mcpServerIds) },
    { icon: LINK_ICONS.skillIds, label: "Skills", value: toolNames(skills, patch.skillIds) },
    { icon: LINK_ICONS.commandIds, label: "Commands", value: toolNames(commands, patch.commandIds) },
  ].filter((link): link is { icon: typeof CpuIcon; label: string; value: string } => link.value !== null)

  return (
    <section aria-label="Pending settings change">
      <header className="mb-2 flex items-center gap-2 px-3">
        {applying ? (
          <Spinner className="size-3 text-muted-foreground" />
        ) : (
          <ClockIcon className="size-3 text-warning" />
        )}
        <h3 className="text-xs font-medium text-muted-foreground">
          {applying ? "Applying settings" : "Settings on next send"}
        </h3>
      </header>
      <div
        className={cn("rounded-xl border bg-muted/50 px-3 py-2", applying && "border-primary/30")}
      >
        <div className="flex flex-wrap gap-1.5">
          {changes.map((change) => (
            <ChangeTile
              key={`${change.kind}-${change.label}`}
              icon={CHANGE_ICONS[change.kind]}
              label={change.label}
              value={change.value}
            />
          ))}
          {links.map((link) => (
            <ChangeTile key={link.label} icon={link.icon} label={link.label} value={link.value} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {applying
            ? steering
              ? "Placing it on the running agent."
              : "Nothing is lost — the conversation comes back through a load."
            : thread.turnActive
              ? steering
                ? now.length === 0
                  ? "Nothing here can be taken mid-turn. It applies on your next send."
                  : `${action} takes ${now.map((c) => c.label).join(", ")} on the running agent.${later.length > 0 ? ` ${later.join(", ")} wait${later.length === 1 ? "s" : ""} for your next send.` : ""}`
                : `Applies when the held turn continues. ${action} takes it now.`
              : `Applies on the next send. ${action} takes it now.`}
        </p>
        {cost && (
          <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
            {isCostly(cost) ? (
              <RefreshCwIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            ) : (
              <CheckIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            )}
            <span>{cost.text}</span>
          </p>
        )}
        {!applying && (
          <div className="mt-2 flex gap-2">
            {canAct && (
              <Button
                size="xs"
                className="flex-1"
                onClick={() => {
                  setApplyingNow(true)
                  void actions
                    .applyStagedConfig(sessionId)
                    .catch((err) => reportError(err, "Couldn't apply that change"))
                    .finally(() => setApplyingNow(false))
                }}
              >
                <CheckIcon data-icon="inline-start" />
                {action}
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              className="flex-1"
              onClick={() => void actions.cancelStagedConfig(sessionId)}
            >
              <XIcon data-icon="inline-start" />
              Cancel
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
