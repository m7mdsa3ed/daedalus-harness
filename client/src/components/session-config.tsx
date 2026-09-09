import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon, ClockIcon, Loader2Icon, XIcon } from "lucide-react"
import { AgentIcon, EntityIcon, ModelIcon, ProfileIcon } from "@/components/entity-icon"
import { AvatarGroup } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MenuRow, MenuRowSkeleton, selectChoices } from "@/components/config-menu"
import type { Actions } from "@/lib/actions"
import { optionKey, optionsForModel, useAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { profileSupports } from "@/lib/settings"
import { useAgents, usePersonas, useProfiles } from "@/lib/queries/catalog"
import { configView, useSessionMeta, useStoreSelect, type ThreadState } from "@/lib/store"

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
 * which. So every pick goes down the same route and the answer comes back.
 *
 * And nothing here asks first. Four of these five settings used to open a
 * confirmation before they would move, which is a dialog in front of a menu
 * row for something that is reversible — the conversation comes back through
 * `session/load`, and the toast that follows a restart carries an Undo. The one
 * case those dialogs were really about, a change that would kill a running
 * turn, is not a choice anybody should have to make at all: the server holds
 * such a change for the turn's own boundary, which is the next moment the
 * setting would be read anyway, and this menu says so and offers to take it
 * sooner. The values it draws are `configView`'s, so a pick is on screen before
 * the request that carries it has left.
 */
export function SessionConfigPopover({
  sessionId,
  actions,
  thread,
  trigger,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  /** Something other than the composer chip to open this menu with. One menu,
      two doors: the held card needs the same model list, and a second copy of
      the catalog resolution above is a second place for it to go wrong. The
      chip's own styling names the composer (`ring-composer`, its type scale),
      which is exactly why it is not reusable as-is. */
  trigger?: React.ReactNode
}) {
  /* This popover lives in the composer row of a live transcript, so it reads
     its own session row and the three catalogs it lists — never the whole
     state, which would redraw the menu on every token of every thread. Each
     catalog is replaced only by its own action. */
  const row = useSessionMeta(sessionId)
  /* …and the row is not the whole answer. A pick this device has just made and
     a change the server is holding for the turn's boundary are both true things
     about how this thread is going to answer, and neither is in the row yet —
     see `configView`. Every read below is of the view; the row is only what a
     change is measured against. */
  const meta = row ? configView(row, thread) : undefined
  const profiles = useProfiles()
  const agents = useAgents()
  const personas = usePersonas()
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
  if (!meta || !row || !profile) return null

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
     its accessible name — and what is true about them that the values alone
     cannot say: a pick that has not landed yet, or one waiting for the send
     that will spend the spawn. Both are states of the *settings*, so they
     belong in the settings' own sentence rather than in a badge somewhere
     else. */
  const triggerLabel = [
    [persona?.name, modelLabel, effortLabel, modeLabel].filter(Boolean).join(" · "),
    meta.configPending ? "— applying…" : meta.configStaged ? "— when you next send" : "",
  ]
    .filter(Boolean)
    .join(" ")

  /** Live ACP change: one call to the running agent, safe mid-turn. Optimistic
      in the store, so the row moves on the click and a refusal puts it back. */
  const set = (option: acp.SessionConfigOption, value: string | boolean) =>
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))

  return (
    <DropdownMenu
      /* The picks are buffered and sent as one request, and closing the menu is
         what says the user is done picking — model then effort is one restart
         instead of two, the second queued behind the first. See
         `actions.changeThreadConfig`. */
      onOpenChange={(open) => {
        if (!open) void actions.flushThreadConfig(sessionId)
      }}
    >
      <DropdownMenuTrigger
        render={
          trigger !== undefined ? (
            (trigger as React.ReactElement)
          ) : (
          <Button
            variant="ghost"
            /* Width is the row's, not the device's: this used to collapse to
               the icon alone under `md`, which made a phone the one place the
               thread's model was unreadable without opening a menu — while the
               same composer squeezed into a narrow dock panel kept saying it,
               because a panel is not a viewport. Both read the same way now:
               the label is capped at `max-w-40` and ellipsized past it, and
               what will not fit scrolls with the rest of the control cluster,
               which is already `overflow-x-auto`. The title still carries the
               settings whole. */
            className="h-6 gap-1 border-0 bg-transparent px-1.5 text-[11px] shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent"
            title={triggerLabel}
          >
            {/* The model's own icon replaces the profile's logo in the pair —
                the two marks stay, it is only the second one that changes. A
                broken model icon falls back to the profile logo, which is what
                would have shown anyway. */}
            {spawnModel?.iconUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? agentId} className="size-4 ring-2 ring-composer" />
                <EntityIcon
                  src={spawnModel.iconUrl}
                  fallback={
                    <ProfileIcon
                      profile={profile}
                      agentId={agent?.id ?? agentId}
                      className="size-4 ring-2 ring-composer"
                    />
                  }
                  className="size-4 ring-2 ring-composer"
                />
              </AvatarGroup>
            ) : profile.logoUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? agentId} className="size-4 ring-2 ring-composer" />
                <ProfileIcon profile={profile} agentId={agent?.id ?? agentId} className="size-4 ring-2 ring-composer" />
              </AvatarGroup>
            ) : (
              <ProfileIcon profile={profile} agentId={agent?.id ?? agentId} className="size-4" />
            )}
            {/* The mode rides along in the trigger: it left the composer, and a
                silently-active "accept edits" is the one setting you must see. */}
            <span className="max-w-40 truncate">
              {persona && <span>{persona.name} · </span>}
              {modelLabel}
              {effortLabel && <span className="capitalize"> · {effortLabel}</span>}
              {modeLabel && ` · ${modeLabel}`}
            </span>
            {/* The chip already shows the value that was picked (the overlay is
                what it reads); this is the half the value cannot say — whether
                it is true yet. A spinner while the change is in flight, a clock
                while it waits for the send that will spend the spawn, and
                nothing at all the rest of the time. */}
            {meta.configPending ? (
              <Loader2Icon className="size-3 shrink-0 animate-spin" />
            ) : meta.configStaged ? (
              <ClockIcon className="size-3 shrink-0" />
            ) : null}
          </Button>
          )
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        {/* What is waiting, and the two things that can be done about it.
            First, because it describes every row underneath it: those rows are
            already drawing the staged values, and without this they would look
            like settings that had simply been applied.

            This is the resting state now, not a warning. A change that costs
            the process is staged the moment it is picked and taken by the next
            spawn — so it reads as information about when, and "Apply now" only
            has a cost worth naming while a turn is actually running. */}
        {thread.stagedConfig && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground">
                Applies when you next send
              </DropdownMenuLabel>
              {/* Cancel only — the staged change is taken by the next spawn,
                  which the composer footer's `ConfigIndicator` says, and the
                  menu is where the pick was made. The "Apply
                  now" that used to live here forced a spawn even when nothing
                  was about to be sent, which is the one auto-apply the reader
                  did not ask for. */}
              <DropdownMenuItem
                onClick={() =>
                  void actions
                    .cancelStagedConfig(sessionId)
                    .catch((err) => reportError(err, "Couldn't cancel that change"))
                }
              >
                <XIcon className="size-4" />
                Cancel the change
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
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
              onSelect={(value) => actions.changeThreadPersona(row, value === NO_PERSONA ? "" : value)}
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
              onSelect={(value) => actions.changeProfile(row, value)}
            />
          )}
          {overridden ? (
            <MenuRow
              label="Model"
              value={meta.model || DEFAULT_CHOICE}
              choices={[
                { value: DEFAULT_CHOICE, name: "Profile default" },
                ...profile.models.map((m) => ({
                  value: m.id,
                  name: m.label,
                  icon: <ModelIcon iconUrl={m.iconUrl} className="size-4" />,
                  group: m.group || undefined,
                })),
              ]}
              /* A new model brings its own effort list, and the one you were on
                 may not be in it — clear rather than carry a stale value into
                 the env. */
              onSelect={(value) =>
                actions.changeSpawnConfig(row, {
                  model: value === DEFAULT_CHOICE ? "" : value,
                  effort: "",
                })
              }
            />
          ) : options.model ? (
            <MenuRow
              label="Model"
              value={options.model.type === "select" ? options.model.currentValue : ""}
              /* Agent-driven options carry no art — every row gets the
                 neutral glyph so the submenu reads like the catalog one. */
              choices={selectChoices(options.model).map((c) => ({
                ...c,
                icon: <BotIcon className="size-4 text-muted-foreground" />,
              }))}
              onSelect={(value) => set(options.model!, value)}
            />
          ) : (
            /* Nothing has said what this agent offers yet — the probe fired on
               open and is a process spawning. A row that is missing reads as a
               setting this agent does not have, and then appears under the
               cursor a second later; a row that is waiting reads as what it is,
               and the menu is the same height either way. */
            unanswered && <MenuRowSkeleton label="Model" />
          )}
          {profileEffort ? (
            <MenuRow
              label="Effort"
              value={meta.effort || DEFAULT_CHOICE}
              choices={[
                { value: DEFAULT_CHOICE, name: "Default" },
                ...spawnEfforts.map((effort) => ({ value: effort, name: effort })),
              ]}
              onSelect={(value) =>
                actions.changeSpawnConfig(row, { effort: value === DEFAULT_CHOICE ? "" : value })
              }
            />
          ) : liveEffort ? (
            <MenuRow
              label="Effort"
              value={liveEffort.type === "select" ? liveEffort.currentValue : ""}
              choices={selectChoices(liveEffort)}
              onSelect={(value) => set(liveEffort, value)}
            />
          ) : (
            unanswered && <MenuRowSkeleton label="Effort" />
          )}
        </DropdownMenuGroup>
        {/* Its own group: suggestions are not about who answers (the Session
            group above) nor the agent's own selectors below — they are how the
            thread's answers should behave. Always drawn: there is no catalog
            to be empty of. */}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session settings</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={meta.suggestFollowups === true}
            onCheckedChange={(checked) => actions.changeThreadSuggestions(row, checked === true)}
          >
            Suggest follow-ups
          </DropdownMenuCheckboxItem>
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
