import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { ProfileIcon } from "@/components/entity-icon"
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
import { optionKey, optionsForModel, useAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { profileSupports } from "@/lib/settings"
import { useSessionMeta, useStoreSelect, type ThreadState } from "@/lib/store"

/** Sentinel for "whatever the profile says", which is not itself a model id. */
const DEFAULT_CHOICE = "__default__"
/** Sentinel for "no persona", which is not itself a persona id. */
const NO_PERSONA = "__none__"

/**
 * Everything about how this thread is answering, behind one compact trigger.
 *
 * Two sources feed it, and the profile decides which one owns the model:
 *
 *   - **A profile that lists models has overridden the agent.** Its ids are the
 *     ones this menu offers. This is the case a gateway profile exists for:
 *     point codex at a router and its own catalog is a list of models your
 *     endpoint does not serve, and the efforts it advertises belong to models it
 *     thinks it is running.
 *   - **A profile that lists none defers to the agent**, whose `category:
 *     "model"` / `"thought_level"` selectors are what the menu draws instead.
 *
 * Either way every *other* agent option is passed through untouched: the
 * override is scoped to the two settings the profile actually replaces.
 *
 * What is *not* decided here is whether a pick costs a restart. It used to be —
 * an overridden model was env, and env means a respawn — but the server can now
 * move most threads without one (see CLAUDE.md), and only the server knows
 * which. So every pick goes down the same route and the answer comes back;
 * `agent.liveConfig` is what this menu reads to decide whether to *warn* first,
 * and it is a claim about the agent, not a promise about this call.
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
  const confirm = useConfirm()
  /* This popover lives in the composer row of a live transcript, so it reads
     its own session row and the three catalogs it lists — never the whole
     state, which would redraw the menu on every token of every thread. Each
     catalog is replaced only by its own action. */
  const meta = useSessionMeta(sessionId)
  const profiles = useStoreSelect((state) => state.profiles)
  const agents = useStoreSelect((state) => state.agents)
  const personas = useStoreSelect((state) => state.personas)
  const profile = profiles.find((p) => p.id === meta?.profileId)
  // The thread's agent, not the profile's: a profile may serve several.
  const agentId = meta?.agentId ?? ""
  const agent = agents.find((a) => a.id === agentId)
  /* The profiles this thread could move to: every one configured for its
     agent. Changing profile is new credentials, never a new runtime. */
  const agentProfiles = profiles.filter((p) => profileSupports(p, agentId))
  // Called before the early return below: hooks cannot be conditional.
  // Sibling profiles serving the same agent stand in while this one has no
  // remembered set — the profile owns only model and effort, so the rest of
  // the agent's options are the same set whichever profile spawned it.
  const remembered = useAgentOptions(
    optionKey(meta?.profileId ?? "", agentId),
    agentProfiles.filter((p) => p.id !== meta?.profileId).map((p) => optionKey(p.id, agentId))
  )
  /* A live session is the authority, but a thread is not always live and not
     every attach carries one (see the fallback below). When nothing has
     answered — an archived thread, a reattach, a device that has never drafted
     on this pair — ask the same way a draft does: one probe per (profile,
     agent) per page-load, no-oped by the action when the set is already known
     or in flight. Without this the *only* thing that ever filled the store was
     the new-thread menu, which is why opening an old thread showed no model
     and no mode until a draft had been opened first.

     Gated on there being nothing to show: a thread whose agent is talking has
     no use for a spawn, and neither has one still borrowing a sibling's set. */
  const unanswered =
    !!meta && thread.configOptions.length === 0 && remembered.base.length === 0
  React.useEffect(() => {
    if (!unanswered || !meta) return
    void actions.learnAgentOptions(meta.profileId, agentId, meta.projectId)
  }, [actions, unanswered, meta?.profileId, agentId, meta?.projectId])
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

  const persona = personas.find((p) => p.id === meta.personaId)

  /* The same settings as one string, for the collapsed trigger's tooltip and
     its accessible name. */
  const triggerLabel = [persona?.name, modelLabel, effortLabel, modeLabel]
    .filter(Boolean)
    .join(" · ")

  /** Live ACP change: one call to the running agent, safe mid-turn. */
  const set = (option: acp.SessionConfigOption, value: string | boolean) =>
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))

  /* Whether this agent can be reconfigured where it stands. A claim about the
     runtime, not about this particular call: the server still decides, and
     falls back to a restart for the cases it cannot do live. What it buys here
     is silence — an agent that takes its model live has nothing to warn about,
     and a confirmation for something instant is noise. */
  const liveReconfig = !!agent?.liveConfig

  /** A model or effort pick. Only warns when the pick is known to cost the
      process, which for a running turn means costing the turn. */
  const setSpawnConfig = async (next: { model?: string; effort?: string }) => {
    if (
      !liveReconfig &&
      thread.turnActive &&
      !(await confirm({
        title: "Restart the agent?",
        description:
          "This profile supplies its own models, which this agent reads at startup — switching restarts it. The running turn stops, then the conversation is restored.",
        confirmLabel: "Restart",
      }))
    )
      return
    actions
      .changeSpawnConfig(meta, next)
      .catch((err) => reportError(err, "Couldn't change the model"))
  }

  /* Still always asks, even where the move is instant — and for a reason that
     has nothing to do with restarting: a profile is a different endpoint, a
     different credential and a different catalog, and the model you are on does
     not carry over to it. That is worth confirming whatever it costs. */
  const changeProfile = async (profileId: string) => {
    const next = profiles.find((p) => p.id === profileId)
    const restarts = !liveReconfig || !profile.baseUrl
    if (
      !(await confirm({
        title: `Move this thread to "${next?.name ?? "another profile"}"?`,
        description: restarts
          ? thread.turnActive
            ? "The agent restarts on the new profile's credentials and default model — the running turn stops, then the conversation is restored."
            : "The agent restarts on the new profile's credentials and default model. The conversation is restored, but the model you are on now does not carry over."
          : "The thread continues on the new profile's credentials and default model. Nothing restarts, but the model you are on now does not carry over.",
        confirmLabel: "Switch profile",
      }))
    )
      return
    actions
      .changeProfile(meta, profileId)
      .catch((err) => reportError(err, "Couldn't switch profile"))
  }

  /* Always asks, whatever `liveReconfig` says, because this one is not a claim
     about the agent: no runtime we ship reads a persona anywhere but at
     `session/new`/`session/load`, so the restart is certain rather than likely.
     What the confirmation is really for is the turn — the conversation comes
     back, the turn in flight does not. */
  const changePersona = async (personaId: string) => {
    const next = personas.find((p) => p.id === personaId)
    if (
      !(await confirm({
        title: next ? `Work this thread as "${next.name}"?` : "Drop this thread's persona?",
        description: thread.turnActive
          ? "The agent reads this at startup, so it restarts. The running turn stops, then the conversation is restored."
          : "The agent reads this at startup, so it restarts. The conversation is restored.",
        confirmLabel: next ? "Switch" : "Drop",
      }))
    )
      return
    actions
      .changeThreadPersona(meta, personaId)
      .catch((err) => reportError(err, "Couldn't change how this thread works"))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            /* Width is the row's, not the device's: this used to collapse to
               the icon alone under `md`, which made a phone the one place the
               thread's model was unreadable without opening a menu — while the
               same composer squeezed into a narrow dock panel kept saying it,
               because a panel is not a viewport. Both read the same way now:
               the label is capped at `max-w-56` and ellipsized past it, and
               what will not fit scrolls with the rest of the control cluster,
               which is already `overflow-x-auto`. The title still carries the
               settings whole. */
            className="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent"
            title={triggerLabel}
          >
            {/* The profile's own logo when it has one (a gateway profile is a
                provider); the Default profile has none and shows the agent. */}
            <ProfileIcon profile={profile} agentId={agent?.id ?? agentId} className="size-4" />
            {/* The mode rides along in the trigger: it left the composer, and a
                silently-active "accept edits" is the one setting you must see. */}
            <span className="max-w-56 truncate">
              {persona && <span>{persona.name} · </span>}
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
          {/* First, because it is the one row here that is about the work
              rather than about the machinery — and because it is the only one
              whose choices do not depend on the profile below it. */}
          {personas.length > 0 && (
            <MenuRow
              label="Persona"
              value={meta.personaId || NO_PERSONA}
              choices={[
                { value: NO_PERSONA, name: "None" },
                ...personas.map((p) => ({ value: p.id, name: p.name })),
              ]}
              onSelect={(value) => void changePersona(value === NO_PERSONA ? "" : value)}
            />
          )}
          {agentProfiles.length > 1 && (
            <MenuRow
              label="Profile"
              value={profile.id}
              choices={agentProfiles.map((p) => ({
                value: p.id,
                name: p.name,
                icon: <ProfileIcon profile={p} agentId={agent?.id ?? agentId} className="size-4" />,
              }))}
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
                setSpawnConfig({ model: value === DEFAULT_CHOICE ? "" : value, effort: "" })
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
              onSelect={(value) => setSpawnConfig({ effort: value === DEFAULT_CHOICE ? "" : value })}
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
