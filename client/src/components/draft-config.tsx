import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon, Loader2, RefreshCwIcon } from "lucide-react"
import { AgentIcon, EntityIcon, ModelIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MenuRow, selectChoices } from "@/components/config-menu"
import { ThreadToolsMenu, useThreadToolCount } from "@/components/thread-tools"
import type { Actions } from "@/lib/actions"
import { optionKey, shownOptions, useAgentOptions, useProbeStatus } from "@/lib/agent-options"
import { currentChoiceLabel, partitionSessionOptions } from "@/lib/session-options"
import { profileSupports, type SessionMeta } from "@/lib/settings"
import { saveThreadDefaults } from "@/lib/thread-defaults"
import { useAgents, usePersonas, useProfiles, useProjects } from "@/lib/queries/catalog"

const DEFAULT_CHOICE = "__default__"
/** Sentinel for "no persona", which is not itself a persona id. */
const NO_PERSONA = "__none__"

/** The shared read of a draft's current configuration — both controls below
    need the same lookups, and they must not disagree about what is selected. */
function useDraft(meta: SessionMeta, actions: Actions, remember = true) {
  /* The four catalogs this menu lists, each on its own subscription rather
     than the whole state: these controls sit on the composer strip of a live
     pane, and a catalog is replaced only by its own action. */
  const projects = useProjects()
  const profiles = useProfiles()
  const agents = useAgents()
  const personas = usePersonas()
  const project = projects.find((p) => p.id === meta.projectId)
  const profile = profiles.find((p) => p.id === meta.profileId)
  // The draft's own agent, not the profile's: a profile may serve several.
  const agent = agents.find((a) => a.id === meta.agentId)
  /* The profiles this thread could run on — every *shown* one configured for
     its agent. The profile only overrides model and effort; the agent is what
     the rest of the menu belongs to, so switching profile keeps it. The draft's
     own profile stays listed even when it has been hidden or disabled since:
     the row must still read what the thread is actually on. */
  const agentProfiles = profiles.filter(
    (p) => profileSupports(p, meta.agentId) && (p.id === meta.profileId || (!p.hidden && !p.disabled))
  )

  const configure = (next: Parameters<Actions["configureDraft"]>[1]) => {
    actions.configureDraft(meta.id, next)
    /* Remembered for the next new thread: the agent you reach for is a habit,
       not a decision worth making twice. Not always, though — `remember: false`
       is for a caller that reuses these controls to configure something that is
       NOT the thread you are about to start (a routine's saved thread-start).
       Picking a profile there is a statement about that routine, and letting it
       move the defaults would mean editing a nightly job silently changed what
       the next ⌘N opens on. */
    if (!remember) return
    saveThreadDefaults({
      projectId: next.projectId ?? meta.projectId,
      profileId: next.profileId ?? meta.profileId,
      agentId: next.agentId ?? meta.agentId,
      model: next.model ?? meta.model,
      effort: next.effort ?? meta.effort,
      personaId: next.personaId ?? meta.personaId,
      suggestFollowups: next.suggestFollowups ?? meta.suggestFollowups,
      uiBlocks: next.uiBlocks ?? meta.uiBlocks,
    })
  }

  return { projects, profiles, agents, personas, project, profile, agent, agentProfiles, configure }
}

/**
 * Where this thread runs and what it carries: the project, and the tools kit.
 *
 * It outlives the draft. Both halves used to disappear at the moment they
 * started mattering — the row was rendered only while `meta.draft`, so the
 * project (the one fact that says *which directory these edits land in*) was
 * visible right up until the first message and never again. It is the same
 * question either side of that message; only the answer's editability changes.
 * A started thread's project is fixed (it IS the agent's cwd), so that half
 * becomes a read-out, exactly as the tools menu already did for itself.
 *
 * Who answers (the agent) is not here — it moved into `DraftConfigPopover`,
 * beside the model whose meaning it decides: see that component's doc.
 */
export function DraftScopeRow({
  meta,
  actions,
  remember = true,
  editable = true,
  side,
  trailing,
}: {
  meta: SessionMeta
  actions: Actions
  /** False when these controls are editing a saved configuration rather than
      the draft you are about to send — see `useDraft`. */
  remember?: boolean
  /** A draft may still pick; a started thread's project and links are already
      spawned, so the row reads them out instead. */
  editable?: boolean
  /** Passed to the tools menu — the row does not know whether it is standing
      in the composer or on a form. See `ThreadToolsMenu`. */
  side?: "top" | "bottom"
  /** Drawn at the row's own end. The composer's context ring goes here: how
      full the window is belongs with where the thread runs, not with the
      controls that send. */
  trailing?: React.ReactNode
}) {
  const { projects, project, configure } = useDraft(meta, actions, remember)
  /* Asked before the menu is drawn rather than left to it: on a started thread
     carrying nothing the menu renders null, and a divider in front of a
     component that decided not to exist is a hairline hanging off the end of
     the row. Same count the menu itself prints. */
  const carries = useThreadToolCount(meta)
  const showTools = editable || carries > 0

  const divider = <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />

  return (
    /* py-1, not the shelf's py-1.5: every control in here is already h-6, so
       the padding is the only slack there is, and this row is under the pile on
       every thread — four pixels here is four pixels off the transcript for the
       whole life of the app. Half a step rather than none, because the row now
       carries four readings at its end and h-6 controls edge to edge read as a
       band rather than as a floor. */
    <div className="flex min-w-0 items-center gap-1 px-2 py-1">
      {editable ? (
        <PickerMenu
          icon={<ProjectIcon project={project} className="size-3.5" />}
          label={project?.name ?? "No project"}
          title="Project"
          value={project?.id ?? ""}
          options={projects.map((p) => ({
            value: p.id,
            name: p.name,
            hint: p.cwd,
            icon: <ProjectIcon project={p} className="size-4" />,
          }))}
          onSelect={(id) => configure({ projectId: id })}
        />
      ) : (
        /* The same shape as the picker beside it, minus the affordance: there
           is nothing to choose, and a menu that opens on one option is a menu
           that lies. The cwd is the title, because "which project" and "which
           directory" are the same question asked at two zoom levels. */
        <span
          title={project?.cwd}
          className="flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground"
        >
          <ProjectIcon project={project} className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{project?.name ?? "No project"}</span>
        </span>
      )}
      {showTools && divider}
      {showTools && (
        <ThreadToolsMenu
          meta={meta}
          actions={actions}
          editable={editable}
          remember={remember}
          side={side}
        />
      )}
      {/* gap-0.5, not the row's gap-1: the cluster is several 24px triggers of
          one kind, so they read as a group of readings rather than as three
          more controls on the row. */}
      {trailing && <span className="ms-auto flex shrink-0 items-center gap-0.5">{trailing}</span>}
    </div>
  )
}

/** One inline picker on the strip: icon, current value, menu. Exported for
    the build page's starter picker, which sits in this row's project slot and
    has to read as the same control. */
export function PickerMenu({
  icon,
  label,
  title,
  value,
  options,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  title: string
  value: string
  options: { value: string; name: string; hint?: string; icon?: React.ReactNode }[]
  onSelect: (value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            title={title}
            className="h-6 min-w-0 gap-1.5 rounded-pill border-0 bg-transparent px-1.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent/50"
          >
            {icon}
            <span className="max-w-40 truncate">{label}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
        {/* DropdownMenuLabel is Base UI's Menu.GroupLabel: it reads its group
            from context and throws outside one, so the label and its items are
            wrapped together rather than sitting loose in the content. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => next && next !== value && onSelect(next)}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.icon}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.name}</span>
                  {option.hint && (
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {option.hint}
                    </span>
                  )}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Who answers and how: agent, profile, persona, model, effort, and — from the
 * agent's remembered `modes` — the permission mode it will start in.
 *
 * The agent leads the list because it decides what every row under it even
 * means (the profiles, models and efforts on offer are a different set per
 * agent) — merged into this one popover rather than a picker of its own on
 * the strip, since picking who answers and picking how it answers are one
 * decision on a draft, not two.
 *
 * Model and effort are placeholders in the agent's env template, filled at
 * spawn — so before the process exists they are ours to set freely, and the
 * profile catalog is the only place that knows what the choices are. The
 * moment the first message creates the session this control is replaced by
 * SessionConfigPopover and the agent's own ACP selectors take over — the
 * agent itself is fixed by then (it is the process that is running), so that
 * later popover has no agent row.
 */
export function DraftConfigPopover({
  meta,
  actions,
  remember = true,
}: {
  meta: SessionMeta
  actions: Actions
  /** See `DraftScopeRow`. */
  remember?: boolean
}) {
  const { agents, profiles, personas, profile, agent, agentProfiles, configure } = useDraft(
    meta,
    actions,
    remember
  )

  /* Switching agent keeps the profile when it serves the new agent too — that
     is the point of a profile naming several — and otherwise moves to the
     first that does (the agent's Default sorts first). Model and effort are
     cleared either way: the same profile catalog may be shared, but the agent
     reads its own env, and a pick made for one runtime is not a pick made for
     the other. */
  const chooseAgent = (agentId: string) => {
    const next =
      profile && profileSupports(profile, agentId) && !profile.hidden && !profile.disabled
        ? profile
        : profiles.find((p) => profileSupports(p, agentId) && !p.hidden && !p.disabled)
    if (!next) return
    configure({ agentId, profileId: next.id, model: "", effort: "" })
  }
  const models = profile?.models ?? []
  const resolvedModel = models.find((m) => m.id === (meta.model || profile?.defaultModel))

  /* What this profile's agent offered the last time one ran. A draft has no
     process to ask, so this is the only way its settings can be picked before
     the thread starts; `createSession` replays the picks once session/new
     answers. The remembered `modes` fold their config-option twin away below,
     as the live menu does — drawn as its own row, a twin pick went out as a
     config choice the server skips in favour of the mode channel. Siblings of the same agent stand in while this profile has no answer of
     its own — the profile only overrides model and effort, so the rest of the
     agent's options are the same set whichever profile is selected. */
  const known = useAgentOptions(
    optionKey(meta.profileId, meta.agentId),
    agentProfiles
      .filter((p) => p.id !== meta.profileId)
      .map((p) => optionKey(p.id, meta.agentId))
  )
  /* Ask this agent on this profile directly, once ever — the action no-ops
     when its own set is already known or the question is in flight. A
     sibling's set above fills the menu meanwhile, but does not answer for this
     profile's env: a different endpoint can carry a different catalog. */
  React.useEffect(() => {
    void actions.learnAgentOptions(meta.profileId, meta.agentId, meta.projectId)
  }, [actions, meta.profileId, meta.agentId, meta.projectId])
  /* Which options exist can depend on which model is picked — opencode only
     offers `effort` on its reasoning models — so read the set recorded for the
     chosen model rather than the one that happened to be live when we looked. */
  const remembered = React.useMemo(
    () => shownOptions(known, meta.configChoices, meta.model, meta.effort),
    [known, meta.configChoices, meta.model, meta.effort]
  )
  const agentOptions = partitionSessionOptions(
    remembered,
    new Set(known.modes?.availableModes.map((m) => m.id) ?? [])
  )
  /* The permission modes, when the agent advertises them on the `modes`
     channel — which daedalus does, and an agent that does would otherwise be
     the one runtime you cannot start in plan mode. Same rule as the live
     menu: only worth a row when there is a choice to make. */
  const modes = known.modes && known.modes.availableModes.length > 1 ? known.modes : null
  const modeLabel = modes?.availableModes.find(
    (m) => m.id === (meta.modeId || modes.currentModeId)
  )?.name

  /* The profile owns the model list when it has one. Effort follows the model:
     the profile's efforts if that model declares any, otherwise the agent's own
     selector — a profile that says nothing about effort is not a profile that
     means "no effort control". Everything else is the agent's, always. */
  const overridden = models.length > 0
  const spawnEfforts = resolvedModel?.reasoningEfforts ?? []
  const profileEffort = overridden && spawnEfforts.length > 0
  const liveEffort = !profileEffort ? agentOptions.effort : undefined
  const optionValue = (option?: acp.SessionConfigOption) =>
    option?.type === "select" ? option.currentValue : ""

  const persona = personas.find((p) => p.id === meta.personaId)
  /* `currentChoiceLabel`, the same reading the started menu draws with — the
     two chips must name the model identically or the pick looks like it moved
     the moment the thread starts. */
  const modelLabel = overridden
    ? (resolvedModel?.label ?? (meta.model || "Profile default"))
    : agentOptions.model
      ? currentChoiceLabel(agentOptions.model)
      : (profile?.name ?? "Agent")
  const effortLabel = profileEffort
    ? meta.effort || null
    : liveEffort
      ? currentChoiceLabel(liveEffort)
      : null

  const choose = (configId: string, value: string | boolean) =>
    actions.chooseDraftConfigOption(meta.id, configId, value)
  const nothingYet = !overridden && remembered.length === 0 && !modes
  /* Why the menu is empty, not just that it is: the probe above is a spawn, so
     "asking" is a real wait, and a failed one is worth a retry rather than a
     sentence that reads like a design decision. */
  const probeStatus = useProbeStatus(optionKey(meta.profileId, meta.agentId))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            /* Ellipsized rather than collapsed, on a phone as in a narrow dock
               panel — same rule as SessionConfigPopover's trigger, which
               replaces this one the moment the thread starts. */
            className="h-6 gap-1 rounded-pill border-0 bg-transparent px-1.5 text-[11px] shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent"
            title={[persona?.name, modelLabel, effortLabel, modeLabel].filter(Boolean).join(" · ")}
          >
            {/* The model's own icon replaces the profile's logo in the pair —
                the two marks stay, it is only the second one that changes. A
                broken model icon falls back to the profile logo, which is what
                would have shown anyway. */}
            {resolvedModel?.iconUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-surface" />
                <EntityIcon
                  src={resolvedModel.iconUrl}
                  fallback={
                    <ProfileIcon
                      profile={profile}
                      agentId={agent?.id ?? meta.agentId}
                      className="size-4 ring-2 ring-surface"
                    />
                  }
                  className="size-4 ring-2 ring-surface"
                />
              </AvatarGroup>
            ) : profile?.logoUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-surface" />
                <ProfileIcon profile={profile} agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-surface" />
              </AvatarGroup>
            ) : (
              <ProfileIcon profile={profile} agentId={agent?.id ?? meta.agentId} className="size-4" />
            )}
            <span className="max-w-40 truncate">
              {agent?.name ?? "No agent"} ·{" "}
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
          <DropdownMenuLabel>Start this thread with</DropdownMenuLabel>
          {/* First, because it decides what every row below it even means —
              switching it resets model and effort (`chooseAgent`) the same
              way switching profile does. */}
          <MenuRow
            label="Agent"
            value={agent?.id ?? ""}
            choices={agents.map((a) => ({
              value: a.id,
              name: a.name,
              icon: <AgentIcon agentId={a.id} className="size-4" />,
            }))}
            onSelect={chooseAgent}
          />
          {/* Above Profile, because it is the only row here that does not
              depend on one — and free on a draft, where the rest of this menu
              is a set of placeholders and nothing has been spawned yet. A
              persona that names an effort applies it on the spot; the row
              below still shows it, and still overrides it. */}
          {personas.length > 0 && (
            <MenuRow
              label="Persona"
              value={meta.personaId || NO_PERSONA}
              choices={[
                { value: NO_PERSONA, name: "None" },
                ...personas.map((p) => ({ value: p.id, name: p.name })),
              ]}
              onSelect={(value) => {
                const picked = value === NO_PERSONA ? null : personas.find((p) => p.id === value)
                configure({
                  personaId: picked?.id ?? "",
                  /* Only when the persona has an opinion: dropping to "" here
                     would make picking "General chat" silently clear an effort
                     the user chose on purpose. The server applies the same rule
                     for a started thread. */
                  ...(picked?.effort ? { effort: picked.effort } : {}),
                })
              }}
            />
          )}
          {agentProfiles.length > 1 && (
            <MenuRow
              label="Profile"
              value={profile?.id ?? ""}
              choices={agentProfiles.map((p) => ({
                value: p.id,
                name: p.name,
                icon: <ProfileIcon profile={p} agentId={meta.agentId} className="size-4" />,
              }))}
              onSelect={(id) => configure({ profileId: id, model: "", effort: "" })}
            />
          )}
          {overridden ? (
            <MenuRow
              label="Model"
              value={meta.model || DEFAULT_CHOICE}
              choices={[
                { value: DEFAULT_CHOICE, name: "Profile default" },
                ...models.map((m) => ({
                  value: m.id,
                  name: m.label,
                  /* Every row carries a mark: the model's own icon when it
                     has one, a neutral glyph otherwise, so rows without art
                     align with those that have it. */
                  icon: <ModelIcon iconUrl={m.iconUrl} className="size-4" />,
                  group: m.group || undefined,
                })),
              ]}
              onSelect={(value) =>
                configure({ model: value === DEFAULT_CHOICE ? "" : value, effort: "" })
              }
            />
          ) : (
            agentOptions.model && (
              <MenuRow
                label="Model"
                value={optionValue(agentOptions.model)}
                /* Agent-driven options carry no art — every row gets the
                   neutral glyph so the submenu reads like the catalog one. */
                choices={selectChoices(agentOptions.model).map((c) => ({
                  ...c,
                  icon: <BotIcon className="size-4 text-muted-foreground" />,
                }))}
                /* The row's own `model`, not a config choice: the agent's model
                   and effort have a channel of their own at spawn
                   (`agentOwned`) and are never replayed from `configChoices`,
                   so a pick left in there would be dropped and the thread would
                   come up on the agent's default. Same field the profile
                   catalog writes — one record either way. */
                onSelect={(value) => configure({ model: value })}
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
              onSelect={(value) => configure({ effort: value === DEFAULT_CHOICE ? "" : value })}
            />
          ) : (
            liveEffort && (
              <MenuRow
                label="Effort"
                value={optionValue(liveEffort)}
                choices={selectChoices(liveEffort)}
                /* Effort travels the same channel as the model — see above. */
                onSelect={(value) => configure({ effort: value })}
              />
            )
          )}
          {nothingYet &&
            (!profile ? (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                Pick a profile to start this thread.
              </DropdownMenuItem>
            ) : probeStatus === "failed" ? (
              /* The one row here that is not disabled: a failed probe is the
                 only one of the three states the reader can do something
                 about, and `force` is what lets it step over the
                 once-per-page-load guard. */
              <DropdownMenuItem
                className="whitespace-normal text-xs"
                onSelect={(event) => {
                  event.preventDefault()
                  void actions.learnAgentOptions(
                    meta.profileId,
                    meta.agentId,
                    meta.projectId,
                    true
                  )
                }}
              >
                <RefreshCwIcon className="size-4 text-muted-foreground" />
                Couldn't reach {agent?.name ?? "this agent"} — try again
              </DropdownMenuItem>
            ) : probeStatus === "asking" ? (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                <Loader2 className="size-4 animate-spin" />
                Asking {agent?.name ?? "the agent"} what it supports…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                {agent?.name ?? "This agent"} offers nothing to configure before the thread
                starts.
              </DropdownMenuItem>
            ))}
        </DropdownMenuGroup>
        {/* Its own group, mirroring the started thread's menu: suggestions are
            how the thread's answers should behave, not who answers — and with
            nothing running yet there is no restart to warn about. */}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Session settings</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={meta.suggestFollowups !== false}
            onCheckedChange={(checked) => configure({ suggestFollowups: checked === true })}
          >
            Suggest follow-ups
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={meta.uiBlocks !== false}
            onCheckedChange={(checked) => configure({ uiBlocks: checked === true })}
          >
            Draw answers as UI
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
        {/* Never touched by the profile: mode and the rest are the agent's, and
            they stay exactly where they are whichever profile is selected. */}
        {(modes || agentOptions.rest.length > 0) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
              {/* First, like the started thread's menu — and remembered on the
                  draft rather than replayed as a config choice, because a mode
                  travels over `session/set_mode`, not `set_config_option`. The
                  server applies it the moment session/new answers. */}
              {modes && (
                <MenuRow
                  label="Mode"
                  value={meta.modeId || modes.currentModeId}
                  choices={modes.availableModes.map((mode) => ({
                    value: mode.id,
                    name: mode.name,
                  }))}
                  onSelect={(modeId) => configure({ modeId })}
                />
              )}
              {agentOptions.rest.map((option) =>
                option.type === "select" ? (
                  <MenuRow
                    key={option.id}
                    label={option.name}
                    value={option.currentValue}
                    choices={selectChoices(option)}
                    onSelect={(value) => choose(option.id, value)}
                  />
                ) : (
                  <DropdownMenuCheckboxItem
                    key={option.id}
                    checked={option.currentValue}
                    onCheckedChange={(checked) => choose(option.id, checked === true)}
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
