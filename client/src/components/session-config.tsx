import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon, ClockIcon, Loader2Icon, XIcon } from "lucide-react"
import { AgentIcon, EntityIcon, ModelIcon, ProfileIcon } from "@/components/entity-icon"
import { AvatarGroup } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { selectChoices } from "@/components/config-menu"
import { INLINE_KIT, MenuKitContext, useMenuKit } from "@/components/menu-kit"
import { useAddModel, useNewProfile } from "@/lib/catalog-add"
import type { Actions } from "@/lib/actions"
import { optionKey, shownOptions, useAgentOptions } from "@/lib/agent-options"
import { reportError } from "@/lib/errors"
import { effectivePricing, formatRate, offPeakLabel, offPeakState } from "@/lib/off-peak"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { profileSupports } from "@/lib/settings"
import { useAgents, usePersonas, useProfiles } from "@/lib/queries/catalog"
import { configView, useSessionMeta, useStoreSelect, type ThreadState } from "@/lib/store"

/**
 * The clock, coarse on purpose.
 *
 * An off-peak window turns over at a minute boundary and nothing here is worth
 * a per-second timer, so this ticks once a minute. It runs for as long as the
 * composer's config trigger is mounted, which is the whole point: the chip is a
 * live reading, not a value someone has to re-open the menu to refresh.
 */
function useMinute(): Date {
  const [now, setNow] = React.useState(() => new Date())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** Sentinel for "whatever the profile says", which is not itself a model id. */
const DEFAULT_CHOICE = "__default__"
/** Sentinel for "no persona", which is not itself a persona id. */
const NO_PERSONA = "__none__"

/**
 * What the settings of a started thread resolve to — the one derivation the
 * popover, the inline panel and the composer's face all read, so the chip and
 * the rows under it cannot disagree about which model this is. Null exactly
 * when there is nothing to draw (no row yet, or its profile is gone).
 *
 * `actions` is what lets it ask: given, a thread nothing has answered for
 * fires the one-shot option probe (see below). A reader that only draws may
 * leave it out, as long as something mounted beside it passes it.
 */
export function useSessionConfigView(sessionId: string, thread: ThreadState, actions?: Actions) {
  /* This menu lives in the composer row of a live transcript, so it reads
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
    if (!unanswered || !meta || !actions) return
    void actions.learnAgentOptions(meta.profileId, agentId, meta.projectId)
  }, [actions, unanswered, meta?.profileId, agentId, meta?.projectId])
  // Called before the return below, for the reason the comment above gives.
  const now = useMinute()
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
  /* The fallback is `shownOptions` — the *same* derivation the new-thread menu
     draws with — rather than the remembered set alone: the row records the
     model and effort this thread is on, and a menu that fell back to whatever
     the remembered set last sat on would state a different model for the
     length of a spawn, a load or a restart, then snap back. Reading the row
     makes it state the same thing the draft did, and stick while the process
     is replaced. */
  const options = partitionSessionOptions(
    live
      ? thread.configOptions
      : shownOptions(remembered, meta.configChoices, meta.model, meta.effort),
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
  /* The provider's cheaper window of the day, if the selected model declares
     one. Only the profile's own catalog can: the window is model metadata, and
     a model the agent owns has nowhere to state one. A reading of the clock,
     not of anything the server sent. */
  const offPeak = spawnModel?.offPeak
  const offPeakNow = offPeak ? offPeakState(offPeak, now) : null
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
    offPeak ? offPeakLabel(offPeak, now) : "",
    meta.configPending ? "— applying…" : meta.configStaged ? "— when you next send" : "",
  ]
    .filter(Boolean)
    .join(" ")


  return {
    row,
    meta,
    profile,
    agent,
    agentId,
    agentProfiles,
    personas,
    persona,
    unanswered,
    now,
    options,
    modes,
    modeLabel,
    overridden,
    spawnModel,
    spawnEfforts,
    offPeak,
    offPeakNow,
    profileEffort,
    liveEffort,
    modelLabel,
    effortLabel,
    triggerLabel,
  }
}

type SessionConfigView = NonNullable<ReturnType<typeof useSessionConfigView>>

/** The settings as one sentence — the accessible name and tooltip of whatever
    control the face is put inside. Null when the face would draw nothing. */
export function useSessionConfigLabel(
  sessionId: string,
  thread: ThreadState,
  actions?: Actions
): string | null {
  return useSessionConfigView(sessionId, thread, actions)?.triggerLabel ?? null
}

/** The trigger's contents, without the trigger: the marks, the label, and what
    is true about the settings that the values cannot say. */
function FaceContents({ view }: { view: SessionConfigView }) {
  const { agent, agentId, spawnModel, profile, persona, modelLabel, effortLabel, modeLabel, offPeakNow, meta } =
    view
  return (
    <>
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
      {/* The one thing about the settings the values cannot say: the
          provider is charging less right now. Drawn only while it is
          true — peak is the ordinary state and needs no badge — and the
          title above carries the window whole, both halves of it. */}
      {offPeakNow?.active && (
        <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
          Off-peak
        </span>
      )}
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
    </>
  )
}

/**
 * The composer's face for this thread's settings — the contents of the
 * popover's trigger, as a fragment, for a caller that draws its own button.
 * Its accessible name is `useSessionConfigLabel`'s: put it on that button's
 * `title`/`aria-label`. Pass `actions` unless the panel is mounted beside it,
 * or an unanswered thread never probes and the face reads the profile's name.
 */
export function SessionConfigFace({
  sessionId,
  thread,
  actions,
}: {
  sessionId: string
  thread: ThreadState
  actions?: Actions
}) {
  const view = useSessionConfigView(sessionId, thread, actions)
  return view ? <FaceContents view={view} /> : null
}

/**
 * The menu's rows, drawn with whatever kit the context supplies — the
 * dropdown's parts behind the popover, flat ones in the inline panel.
 */
function SessionConfigBody({
  sessionId,
  actions,
  thread,
  view,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
  view: SessionConfigView
}) {
  const kit = useMenuKit()
  const newProfile = useNewProfile()
  const addModel = useAddModel()
  const {
    row,
    meta,
    profile,
    agent,
    agentId,
    agentProfiles,
    personas,
    unanswered,
    now,
    options,
    modes,
    overridden,
    spawnModel,
    spawnEfforts,
    offPeak,
    profileEffort,
    liveEffort,
  } = view

  /** Live ACP change: one call to the running agent, safe mid-turn. Optimistic
      in the store, so the row moves on the click and a refusal puts it back. */
  const set = (option: acp.SessionConfigOption, value: string | boolean) =>
    actions
      .setConfigOption(sessionId, option.id, value)
      .catch((err) => reportError(err, `Couldn't change ${option.name}`))


  return (
    <>
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
          <kit.Group>
            <kit.Label className="text-muted-foreground">
              Applies when you next send
            </kit.Label>
            {/* Cancel only — the staged change is taken by the next spawn,
                which the composer footer's `ConfigIndicator` says, and the
                menu is where the pick was made. The "Apply
                now" that used to live here forced a spawn even when nothing
                was about to be sent, which is the one auto-apply the reader
                did not ask for. */}
            <kit.Item
              onClick={() =>
                void actions
                  .cancelStagedConfig(sessionId)
                  .catch((err) => reportError(err, "Couldn't cancel that change"))
              }
            >
              <XIcon className="size-4" />
              Cancel the change
            </kit.Item>
          </kit.Group>
          <kit.Separator />
        </>
      )}
      <kit.Group>
        <kit.Label>Session</kit.Label>
        {/* First, because it is the one row here that is about the work
            rather than about the machinery — and because it is the only one
            whose choices do not depend on the profile below it. */}
        {personas.length > 0 && (
          <kit.Row
            label="Persona"
            value={meta.personaId || NO_PERSONA}
            choices={[
              { value: NO_PERSONA, name: "None" },
              ...personas.map((p) => ({ value: p.id, name: p.name })),
            ]}
            onSelect={(value) => actions.changeThreadPersona(row, value === NO_PERSONA ? "" : value)}
          />
        )}
        {/* Drawn on a single profile too — the row is also the door to
            making another. See the draft menu's copy of this. */}
        <kit.Row
          label="Profile"
          value={profile.id}
          choices={agentProfiles.map((p) => ({
            value: p.id,
            name: p.name,
            icon: <ProfileIcon profile={p} agentId={agent?.id ?? agentId} className="size-4" />,
          }))}
          onSelect={(value) => actions.changeProfile(row, value)}
          add={{
            // Adding one moves the thread onto it — that is why it was made.
            label: "New profile…",
            onSelect: () => newProfile((id) => actions.changeProfile(row, id)),
          }}
        />
        {overridden ? (
          <kit.Row
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
            /* Only where the profile already owns the catalog — see the
               draft menu's copy of this. Selecting the new model is the
               same spawn-config change picking an existing one would be, so
               it is staged or applied by the same rules. */
            add={
              profile.virtual
                ? undefined
                : {
                    label: "Add model…",
                    onSelect: () =>
                      addModel(profile.id, (id) =>
                        actions.changeSpawnConfig(row, { model: id, effort: "" })
                      ),
                  }
            }
          />
        ) : options.model ? (
          <kit.Row
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
          unanswered && <kit.RowSkeleton label="Model" />
        )}
        {/* The window in full, under the row that owns it: which side of it
            we are on and when it next flips. A property of the model, so it
            reads like one — and it says nothing at all for a model with a
            single all-day rate, which is most of them. */}
        {offPeak && (
          <div className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">
            {offPeakLabel(offPeak, now)}
            {spawnModel?.pricing &&
              ` · ${formatRate(effectivePricing(spawnModel.pricing, offPeak, now) ?? spawnModel.pricing)}`}
          </div>
        )}
        {profileEffort ? (
          <kit.Row
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
          <kit.Row
            label="Effort"
            value={liveEffort.type === "select" ? liveEffort.currentValue : ""}
            choices={selectChoices(liveEffort)}
            onSelect={(value) => set(liveEffort, value)}
          />
        ) : (
          unanswered && <kit.RowSkeleton label="Effort" />
        )}
      </kit.Group>
      {/* Its own group: suggestions are not about who answers (the Session
          group above) nor the agent's own selectors below — they are how the
          thread's answers should behave. Always drawn: there is no catalog
          to be empty of. */}
      <kit.Separator />
      <kit.Group>
        <kit.Label>Session settings</kit.Label>
        <kit.CheckboxItem
          checked={meta.suggestFollowups === true}
          onCheckedChange={(checked) => actions.changeThreadSuggestions(row, checked === true)}
        >
          Suggest follow-ups
        </kit.CheckboxItem>
        {/* The same spawn-text bargain: the lane is system-prompt text, so a
            flip costs a respawn and the server says so. Off, the model is
            never *asked* for one — a fence that arrives anyway still draws,
            because the drawing is the client's and it reads no toggle. */}
        <kit.CheckboxItem
          checked={meta.uiBlocks !== false}
          onCheckedChange={(checked) => actions.changeThreadUiBlocks(row, checked === true)}
        >
          Draw answers as UI
        </kit.CheckboxItem>
      </kit.Group>
      {(modes || options.rest.length > 0) && (
        <>
          <kit.Separator />
          <kit.Group>
            <kit.Label>Agent options</kit.Label>
            {/* Untouched by the override above: only model and effort are the
                profile's to replace, and everything the agent offers besides
                them still applies live. */}
            {modes && (
              <kit.Row
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
                <kit.Row
                  key={option.id}
                  label={option.name}
                  value={option.currentValue}
                  choices={selectChoices(option)}
                  onSelect={(value) => set(option, value)}
                />
              ) : (
                <kit.CheckboxItem
                  key={option.id}
                  checked={option.currentValue}
                  onCheckedChange={(checked) => set(option, checked === true)}
                >
                  {option.name}
                </kit.CheckboxItem>
              )
            )}
          </kit.Group>
        </>
      )}
    </>
  )
}

/**
 * The same rows, in flow and with no popup — the composer's panel. Closing the
 * panel is what says the user is done picking, so unmounting flushes the
 * buffered picks exactly as the dropdown's close does.
 */
export function SessionConfigPanel({
  sessionId,
  actions,
  thread,
}: {
  sessionId: string
  actions: Actions
  thread: ThreadState
}) {
  const view = useSessionConfigView(sessionId, thread, actions)
  React.useEffect(() => () => void actions.flushThreadConfig(sessionId), [actions, sessionId])
  if (!view) return null
  return (
    <MenuKitContext value={INLINE_KIT}>
      <div className="flex flex-col gap-0.5 text-sm">
        <SessionConfigBody sessionId={sessionId} actions={actions} thread={thread} view={view} />
      </div>
    </MenuKitContext>
  )
}

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
  const view = useSessionConfigView(sessionId, thread, actions)
  if (!view) return null
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
              className="h-6 gap-1 rounded-pill border-0 bg-transparent px-1.5 text-[11px] shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent"
              title={view.triggerLabel}
            >
              <FaceContents view={view} />
            </Button>
          )
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <SessionConfigBody sessionId={sessionId} actions={actions} thread={thread} view={view} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
