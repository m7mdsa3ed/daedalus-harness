import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon, CheckIcon, ClockIcon, Loader2Icon, XIcon } from "lucide-react"
import { AgentIcon, EntityIcon, ModelIcon, ProfileIcon } from "@/components/entity-icon"
import { AvatarGroup } from "@/components/ui/avatar"
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
import { levelOf, withEffortIcons, withModeIcons } from "@/components/composer/option-icons"
import { type ChoicePick, HelperModelsSub, MenuRow, MenuRowSkeleton, PILL, PillLabel, SessionSettingsSub, selectChoices } from "@/components/config-menu"
import { DraftConfigPopover } from "@/components/draft-config"
import { ThreadToolsSections } from "@/components/thread-tools/menu"
import { useIsMobile } from "@/hooks/use-device"
import { useMenuShortcut } from "@/hooks/use-hotkey"
import { useAddModel, useNewProfile } from "@/lib/catalog-add"
import type { Actions } from "@/lib/actions"
import { optionKey, shownOptions, useAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { profileSupports, type SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles } from "@/lib/queries/catalog"
import { useModelRoles } from "@/lib/queries/model-roles"
import { configView, stagedPicks, useSessionMeta, useStoreSelect, type ThreadState } from "@/lib/store"

/** Sentinel for "whatever the profile says", which is not itself a model id. */
const DEFAULT_CHOICE = "__default__"

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
  shell,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  /** Open state owned by `ConfigPopover`, so it survives the draft's swap. */
  shell?: PopoverShell
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
  const profile = profiles.find((p) => p.id === meta?.profileId)
  // The thread's agent, not the profile's: a profile may serve several.
  const agentId = meta?.agentId ?? ""
  const agent = agents.find((a) => a.id === agentId)
  /* The profiles this thread could move to: every shown one configured for
     its agent. Changing profile is new credentials, never a new runtime. A
     hidden or disabled profile is offered no more here than it is on a draft —
     but the thread's own stays listed if it is the one it runs on, so the menu
     still reads it out. */
  const agentProfiles = profiles.filter(
    (p) => profileSupports(p, agentId) && (p.id === meta?.profileId || (!p.hidden && !p.disabled))
  )
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
  const newProfile = useNewProfile()
  const addModel = useAddModel()
  /* The role vocabulary the helper-model rows pick from (docs/model-roles.md). */
  const modelRoles = useModelRoles()
  if (!meta || !row || !profile) return null

  /* The agent's own selectors, under what is staged for the next turn — so a
     pick reads as picked, and the clock above says it is not yet true. */
  const picks = stagedPicks(thread)
  const modeIds = new Set(picks.modes?.availableModes.map((m) => m.id) ?? [])
  /* A live session is the authority on its own settings — but it is not always
     able to say. `session/new` returns the option set; a plain reattach makes
     no call that carries one, and a `session/load` on revive is free to answer
     without one. In either case `thread.configOptions` is empty and this menu
     used to go blank, while the new-thread menu — reading the same agent's
     remembered set — showed everything. Same source, same fallback: what the
     profile's agent last advertised, replaced the moment the session speaks. */
  const live = picks.configOptions.length > 0
  /* The fallback is `shownOptions` — the *same* derivation the new-thread menu
     draws with — rather than the remembered set alone: the row records the
     model and effort this thread is on, and a menu that fell back to whatever
     the remembered set last sat on would state a different model for the
     length of a spawn, a load or a restart, then snap back. Reading the row
     makes it state the same thing the draft did, and stick while the process
     is replaced. */
  const options = partitionSessionOptions(
    live
      ? picks.configOptions
      : shownOptions(remembered, meta.configChoices, meta.model, meta.effort),
    modeIds
  )
  const modes = picks.modes && picks.modes.availableModes.length > 1 ? picks.modes : null
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


  /* The same settings as one string, for the collapsed trigger's tooltip and
     its accessible name. What is true about them that the values alone cannot
     say — a pick that has not landed yet, or one waiting for the send that will
     spend the spawn — is the transcript's to tell (`pending-settings.tsx`), not
     a second reading here. */
  const triggerLabel = [modelLabel, effortLabel, modeLabel].filter(Boolean).join(" · ")

  /** Live ACP change: one call to the running agent, safe mid-turn. Optimistic
      in the store, so the row moves on the click and a refusal puts it back. */
  const set = (option: acp.SessionConfigOption, value: string | boolean) =>
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))

  const profilePick: ChoicePick = {
    label: "Profile",
    value: profile.id,
    choices: agentProfiles.map((p) => ({
      value: p.id,
      name: p.name,
      icon: <ProfileIcon profile={p} agentId={agent?.id ?? agentId} className="size-4" />,
    })),
    onSelect: (value) => actions.changeProfile(row, value),
    add: {
      // Adding one moves the thread onto it — that is why it was made.
      label: "New profile…",
      onSelect: () => newProfile((id) => actions.changeProfile(row, id)),
    },
  }
  const effortPick: ChoicePick | null = profileEffort
    ? {
        label: "Effort",
        value: meta.effort || DEFAULT_CHOICE,
        choices: withEffortIcons([
          { value: DEFAULT_CHOICE, name: "Default" },
          ...spawnEfforts.map((effort) => ({ value: effort, name: effort })),
        ]),
        onSelect: (value) =>
          actions.changeSpawnConfig(row, { effort: value === DEFAULT_CHOICE ? "" : value }),
      }
    : liveEffort
      ? {
          label: "Effort",
          value: liveEffort.type === "select" ? liveEffort.currentValue : "",
          choices: withEffortIcons(selectChoices(liveEffort)),
          onSelect: (value) => set(liveEffort, value),
        }
      : null

  /* The model's choices, whichever source owns them — one object for the row
     and the sheet it opens, so the two cannot disagree about what is listed. */
  const modelPick: ChoicePick | null = overridden
    ? {
        label: "Model",
        value: meta.model || DEFAULT_CHOICE,
        choices: [
          { value: DEFAULT_CHOICE, name: "Profile default" },
          ...profile.models.map((m) => ({
            value: m.id,
            name: m.label,
            icon: <ModelIcon iconUrl={m.iconUrl} className="size-4" />,
            group: m.group || undefined,
          })),
        ],
        /* A new model brings its own effort list, and the one you were on
           may not be in it — clear rather than carry a stale value. */
        onSelect: (value) =>
          actions.changeSpawnConfig(row, {
            model: value === DEFAULT_CHOICE ? "" : value,
            effort: "",
          }),
        add: profile.virtual
          ? undefined
          : {
              label: "Add model…",
              onSelect: () =>
                addModel(profile.id, (id) =>
                  actions.changeSpawnConfig(row, { model: id, effort: "" })
                ),
            },
      }
    : options.model
      ? {
          label: "Model",
          value: options.model.type === "select" ? options.model.currentValue : "",
          /* Agent-driven options carry no art — every row gets the neutral
             glyph so the list reads like the catalog one. */
          choices: selectChoices(options.model).map((c) => ({
            ...c,
            icon: <BotIcon className="size-4 text-muted-foreground" />,
          })),
          onSelect: (value) => set(options.model!, value),
        }
      : null

  return (
    <DropdownMenu
      /* The picks are buffered and sent as one request, and closing the menu is
         what says the user is done picking — model then effort is one restart
         instead of two, the second queued behind the first. See
         `actions.changeThreadConfig`. */
      open={shell?.open}
      onOpenChange={(open) => {
        shell?.setOpen(open)
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
            /* Width is the row's, not the device's: the label is capped and
               ellipsized, and what will not fit scrolls with the rest of the
               control cluster. The title still carries the settings whole. */
            className={PILL}
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
            {/* The mode rides along in the trigger: a silently-active "accept
                edits" is the one setting you must see. */}
            <PillLabel
              model={modelLabel}
              effort={effortLabel}
              effortLevel={
                profileEffort
                  ? levelOf(spawnEfforts, meta.effort)
                  : liveEffort
                    ? levelOf(
                        selectChoices(liveEffort).map((c) => c.value),
                        liveEffort.type === "select" ? liveEffort.currentValue : undefined
                      )
                    : null
              }
              mode={modeLabel}
              modeId={modes?.currentModeId}
            />
          </Button>
          )
        }
      />
      <DropdownMenuContent align="start" className="w-60" finalFocus={shell?.finalFocus}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          {/* Drawn on a single profile too — the row is also the door to
              making another. */}
          <MenuRow {...profilePick} />
          {modelPick ? (
            <MenuRow {...modelPick} />
          ) : (
            /* Nothing has said what this agent offers yet — the probe fired on
               open. A row that is waiting reads as what it is, and the menu is
               the same height either way. */
            unanswered && <MenuRowSkeleton label="Model" />
          )}
          {effortPick ? (
            <MenuRow {...effortPick} />
          ) : (
            unanswered && <MenuRowSkeleton label="Effort" />
          )}
          {meta && agent?.subagentModelsVia === "acp-env" && (
            <HelperModelsSub
              rows={meta.helperModels ?? []}
              roles={modelRoles}
              models={modelPick?.choices.filter((c) => c.value !== DEFAULT_CHOICE) ?? []}
              onChange={(helperModels) => actions.changeHelperModels(row, helperModels)}
            />
          )}
        </DropdownMenuGroup>
        {/* What the thread is running with. Read-only once it has started:
            the links are what a revive spawns with. */}
        <ThreadToolsSections meta={row} actions={actions} editable={false} />
        {/* Its own group: how the thread's answers should behave, not who
            answers nor the agent's own selectors. */}
        <DropdownMenuSeparator />
        {/* Its own submenu: how the thread's answers should behave, not who
            answers nor the agent's own selectors. The UI lane is system-prompt
            text, so a flip costs a respawn; off, the model is never *asked* for
            one — a fence that arrives anyway still draws, because the renderer
            reads no toggle. */}
        <SessionSettingsSub
          items={[
            {
              label: "Suggest follow-ups",
              checked: meta.suggestFollowups === true,
              onChange: (checked) => actions.changeThreadSuggestions(row, checked),
            },
            {
              label: "Draw answers as UI",
              checked: meta.uiBlocks !== false,
              onChange: (checked) => actions.changeThreadUiBlocks(row, checked),
            },
          ]}
        />
        {(modes || options.rest.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
              {/* Untouched by the profile: only model and effort are the
                  profile's to replace. */}
              {modes && (
                <MenuRow
                  label="Mode"
                  value={modes.currentModeId}
                  choices={withModeIcons(
                    modes.availableModes.map((mode) => ({
                      value: mode.id,
                      name: mode.name,
                    }))
                  )}
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

/** Menu open state lifted out of the two bodies, so a flip between them keeps it. */
export type PopoverShell = {
  open: boolean
  setOpen: (open: boolean) => void
  /** Where a close sends the caret — see `useMenuShortcut`. */
  finalFocus?: () => HTMLElement | true
}

/**
 * The composer's one config picker. It holds the open state and picks the draft
 * or the session body, so the first send (`meta.draft` flipping false) does not
 * close a menu the reader has open. The bodies themselves are still two
 * components, so their DOM remounts; only the state is continuous.
 * Renders the draft body until the session row and its profile exist.
 */
export function ConfigPopover({
  meta,
  sessionId,
  actions,
  thread,
  keys = false,
}: {
  meta: SessionMeta
  sessionId: string
  actions: Actions
  thread: ThreadState
  /** Answer `changeModel` — only the composer in front of you may. */
  keys?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const finalFocus = useMenuShortcut("changeModel", () => setOpen(!open), keys)
  const profiles = useProfiles()
  const shell = { open, setOpen, finalFocus }
  const ready = !meta.draft && profiles.some((p) => p.id === meta.profileId)
  return ready ? (
    <SessionConfigPopover sessionId={sessionId} actions={actions} thread={thread} shell={shell} />
  ) : (
    <DraftConfigPopover meta={meta} actions={actions} shell={shell} />
  )
}
