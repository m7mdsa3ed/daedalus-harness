import type * as acp from "@agentclientprotocol/sdk"
import { AgentIcon } from "@/components/agent-icon"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MenuRow, selectChoices } from "@/components/config-menu"
import type { Actions } from "@/lib/actions"
import { optionsForModel, useAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { useStore, type ThreadState } from "@/lib/store"

/** Sentinel for "whatever the profile says", which is not itself a model id. */
const DEFAULT_CHOICE = "__default__"

/**
 * Everything about how this thread is answering, behind one compact trigger.
 *
 * Two sources feed it, and the profile decides which one owns the model:
 *
 *   - **A profile that lists models has overridden the agent.** Those ids reach
 *     the agent only through its env, so picking one restarts the process. This
 *     is the case a gateway profile exists for: point codex at a router and its
 *     own catalog is a list of models your endpoint does not serve, and the
 *     efforts it advertises belong to models it thinks it is running.
 *   - **A profile that lists none defers to the agent**, whose `category:
 *     "model"` / `"thought_level"` selectors apply in a single ACP call with no
 *     restart at all.
 *
 * Either way every *other* agent option is passed through untouched: the
 * override is scoped to the two settings the profile actually replaces.
 */
export function SessionConfigPopover({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const { state } = useStore()
  const confirm = useConfirm()
  const meta = state.sessions.find((s) => s.id === sessionId)
  const profile = state.profiles.find((p) => p.id === meta?.profileId)
  const agent = state.agents.find((a) => a.id === profile?.agentId)
  // Called before the early return below: hooks cannot be conditional.
  // Sibling profiles of the same agent stand in while this one has no
  // remembered set — the profile owns only model and effort, so the rest of
  // the agent's options are the same set whichever profile spawned it.
  const remembered = useAgentOptions(
    meta?.profileId ?? "",
    state.profiles
      .filter((p) => p.agentId === profile?.agentId && p.id !== meta?.profileId)
      .map((p) => p.id)
  )
  if (!meta || !profile) return null

  const modeIds = new Set(thread.modes?.availableModes.map((m) => m.id) ?? [])
  /* A live session is the authority on its own settings — but it is not always
     able to say. `session/new` returns the option set; a plain reattach makes
     no call that carries one, and a `session/load` on revive is free to answer
     without one. In either case `thread.configOptions` is empty and this menu
     used to go blank, while the new-thread menu — reading the same agent's
     remembered set — showed everything. Same source, same fallback: what the
     profile's agent last advertised, replaced the moment the session speaks. */
  const live = thread.configOptions.length > 0
  const options = partitionSessionOptions(
    live ? thread.configOptions : optionsForModel(remembered, meta.model || undefined),
    modeIds
  )
  const agentProfiles = state.profiles.filter((p) => p.agentId === profile.agentId)
  const modes = thread.modes && thread.modes.availableModes.length > 1 ? thread.modes : null
  const modeLabel = modes?.availableModes.find((m) => m.id === modes.currentModeId)?.name

  /* The profile's catalog wins where it has one; where it does not, the agent's.
     Effort follows the model: the profile's efforts when that model declares
     any, otherwise the agent's own live selector. A profile that says nothing
     about effort has not said "this model has no effort control", and hiding
     the agent's working selector on its behalf would be inventing a claim it
     never made. */
  const overridden = profile.models.length > 0
  const spawnModel = profile.models.find((m) => m.id === (meta.model || profile.defaultModel))
  const spawnEfforts = spawnModel?.reasoningEfforts ?? []
  const profileEffort = overridden && spawnEfforts.length > 0
  const liveEffort = profileEffort ? undefined : options.effort

  const modelLabel = overridden
    ? (spawnModel?.label ?? (meta.model || "Profile default"))
    : options.model
      ? currentChoiceLabel(options.model)
      : profile.name
  const effortLabel = profileEffort
    ? meta.effort || null
    : liveEffort
      ? currentChoiceLabel(liveEffort)
      : null

  /* The same three settings as one string, for the collapsed trigger's tooltip
     and its accessible name. */
  const triggerLabel = [modelLabel, effortLabel, modeLabel].filter(Boolean).join(" · ")

  /** Live ACP change: one call to the running agent, safe mid-turn. */
  const set = (option: acp.SessionConfigOption, value: string | boolean) =>
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))

  /** Env change: the process restarts, so a running turn dies with it. */
  const respawnWith = async (next: { model?: string; effort?: string }) => {
    if (
      thread.turnActive &&
      !(await confirm({
        title: "Restart the agent?",
        description:
          "This profile supplies its own models, which the agent reads at startup — switching restarts it. The running turn stops, then the conversation is restored.",
        confirmLabel: "Restart",
      }))
    )
      return
    actions
      .changeSpawnConfig(meta, next)
      .catch((err) => reportError(err, "Couldn't restart the agent"))
  }

  /* Always asks, turn or no turn. Changing profile is not retuning: it is new
     credentials, a new endpoint and a new model catalog, and the model you were
     on almost certainly does not exist on the other side. */
  const changeProfile = async (profileId: string) => {
    const next = state.profiles.find((p) => p.id === profileId)
    if (
      !(await confirm({
        title: `Move this thread to "${next?.name ?? "another profile"}"?`,
        description: thread.turnActive
          ? "The agent restarts on the new profile's credentials and default model — the running turn stops, then the conversation is restored."
          : "The agent restarts on the new profile's credentials and default model. The conversation is restored, but the model you are on now does not carry over.",
        confirmLabel: "Switch profile",
      }))
    )
      return
    actions
      .changeProfile(meta, profileId)
      .catch((err) => reportError(err, "Couldn't switch profile"))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            /* On a phone the composer row has no width to spend on prose: the
               trigger collapses to the icon alone (square, same 32px as every
               other control in the row) and the settings it names move into the
               title. The menu itself is unchanged — one tap still shows them. */
            className="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent max-md:w-8 max-md:px-0"
            title={triggerLabel}
          >
            <AgentIcon agentId={agent?.id ?? profile.agentId} className="size-4" />
            {/* The mode rides along in the trigger: it left the composer, and a
                silently-active "accept edits" is the one setting you must see. */}
            <span className="max-w-56 truncate max-md:sr-only">
              {modelLabel}
              {effortLabel && <span className="capitalize"> · {effortLabel}</span>}
              {modeLabel && ` · ${modeLabel}`}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          {agentProfiles.length > 1 && (
            <MenuRow
              label="Profile"
              value={profile.id}
              choices={agentProfiles.map((p) => ({ value: p.id, name: p.name }))}
              onSelect={changeProfile}
            />
          )}
          {overridden ? (
            <MenuRow
              label="Model"
              value={meta.model || DEFAULT_CHOICE}
              choices={[
                { value: DEFAULT_CHOICE, name: "Profile default" },
                ...profile.models.map((m) => ({ value: m.id, name: m.label })),
              ]}
              /* A new model brings its own effort list, and the one you were on
                 may not be in it — clear rather than carry a stale value into
                 the env. */
              onSelect={(value) =>
                respawnWith({ model: value === DEFAULT_CHOICE ? "" : value, effort: "" })
              }
            />
          ) : (
            options.model && (
              <MenuRow
                label="Model"
                value={options.model.type === "select" ? options.model.currentValue : ""}
                choices={selectChoices(options.model)}
                onSelect={(value) => set(options.model!, value)}
              />
            )
          )}
          {profileEffort ? (
            <MenuRow
              label="Effort"
              value={meta.effort || DEFAULT_CHOICE}
              choices={[
                { value: DEFAULT_CHOICE, name: "Default" },
                ...spawnEfforts.map((effort) => ({ value: effort, name: effort })),
              ]}
              onSelect={(value) => respawnWith({ effort: value === DEFAULT_CHOICE ? "" : value })}
            />
          ) : (
            liveEffort && (
              <MenuRow
                label="Effort"
                value={liveEffort.type === "select" ? liveEffort.currentValue : ""}
                choices={selectChoices(liveEffort)}
                onSelect={(value) => set(liveEffort, value)}
              />
            )
          )}
        </DropdownMenuGroup>
        {(modes || options.rest.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
              {/* Untouched by the override above: only model and effort are the
                  profile's to replace, and everything the agent offers besides
                  them still applies live. */}
              {modes && (
                <MenuRow
                  label="Mode"
                  value={modes.currentModeId}
                  choices={modes.availableModes.map((mode) => ({
                    value: mode.id,
                    name: mode.name,
                  }))}
                  onSelect={(modeId) =>
                    actions
                      .setMode(sessionId, modeId)
                      .catch((err) => reportError(err, "Couldn't switch mode"))
                  }
                />
              )}
              {options.rest.map((option) =>
                option.type === "select" ? (
                  <MenuRow
                    key={option.id}
                    label={option.name}
                    value={option.currentValue}
                    choices={selectChoices(option)}
                    onSelect={(value) => set(option, value)}
                  />
                ) : (
                  <DropdownMenuCheckboxItem
                    key={option.id}
                    checked={option.currentValue}
                    onCheckedChange={(checked) => set(option, checked === true)}
                  >
                    {option.name}
                  </DropdownMenuCheckboxItem>
                )
              )}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
