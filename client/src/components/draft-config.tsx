import * as React from "react"
import type * as acp from "@daedalus/acp"
import { BotIcon } from "lucide-react"
import { AgentIcon, EntityIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
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
import { useStripSummary } from "@/components/composer-strip"
import { ThreadToolsMenu } from "@/components/thread-tools"
import type { Actions } from "@/lib/actions"
import { optionKey, optionsForModel, useAgentOptions, withChoices } from "@/lib/agent-options"
import { partitionSessionOptions } from "@/lib/session-options"
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
  /* The profiles this thread could run on — every one configured for its
     agent. The profile only overrides model and effort; the agent is what the
     rest of the menu belongs to, so switching profile keeps it. */
  const agentProfiles = profiles.filter((p) => profileSupports(p, meta.agentId))

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
    })
  }

  return { projects, profiles, agents, personas, project, profile, agent, agentProfiles, configure }
}

/**
 * Where this thread will run and who will answer it: project and agent.
 *
 * These sit on the composer strip rather than inside the settings menu because
 * they are the two choices that change what everything *else* in the menu even
 * means — pick a different agent and the profiles, models and efforts under it
 * are a different set. They are also the two you want to see without opening
 * anything, since a thread started in the wrong project is started in the wrong
 * working directory.
 *
 * Draft-only. Once the session exists the project is fixed (it is the agent's
 * cwd) and the agent is the process that is running.
 */
export function DraftScopeRow({
  meta,
  actions,
  remember = true,
  hideProject = false,
  leading,
}: {
  meta: SessionMeta
  actions: Actions
  /** False when these controls are editing a saved configuration rather than
      the draft you are about to send — see `useDraft`. */
  remember?: boolean
  /** Drop the project half. For a caller whose project does not exist yet —
      the build page, which makes one from a starter at send time. */
  hideProject?: boolean
  /** Drawn where the project picker would be (or after the agent when the
      project is shown): the build page's starter picker. */
  leading?: React.ReactNode
}) {
  const { projects, agents, profiles, project, profile, agent, configure } = useDraft(meta, actions, remember)

  /* On the strip's collapsed line this row is its two answers: which agent will
     take the thread, and which project it will run in. That is the whole point
     of the row, so the summary says it outright rather than "Draft settings". */
  useStripSummary({
    id: "scope",
    icon: BotIcon,
    label: hideProject
      ? (agent?.name ?? "No agent")
      : `${agent?.name ?? "No agent"} · ${project?.name ?? "No project"}`,
  })

  /* Switching agent keeps the profile when it serves the new agent too — that
     is the point of a profile naming several — and otherwise moves to the
     first that does (the agent's Default sorts first). Model and effort are
     cleared either way: the same profile catalog may be shared, but the agent
     reads its own env, and a pick made for one runtime is not a pick made for
     the other. */
  const chooseAgent = (agentId: string) => {
    const next =
      profile && profileSupports(profile, agentId)
        ? profile
        : profiles.find((p) => profileSupports(p, agentId))
    if (!next) return
    configure({ agentId, profileId: next.id, model: "", effort: "" })
  }

  const divider = <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <PickerMenu
        icon={
          agent ? (
            <AgentIcon agentId={agent.id} className="size-3.5" />
          ) : (
            <BotIcon className="size-3.5" />
          )
        }
        label={agent?.name ?? "No agent"}
        title="Agent"
        value={agent?.id ?? ""}
        options={agents.map((a) => ({
          value: a.id,
          name: a.name,
          icon: <AgentIcon agentId={a.id} className="size-4" />,
        }))}
        onSelect={chooseAgent}
      />
      {leading && (
        <>
          {divider}
          {leading}
        </>
      )}
      {!hideProject && (
        <>
          {divider}
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
        </>
      )}
      {divider}
      <ThreadToolsMenu meta={meta} actions={actions} editable remember={remember} />
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
            className="h-6 min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent/50"
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
 * The chosen agent's own configuration, in the slot the settings trigger always
 * occupies: profile, model, effort.
 *
 * This is the *other* half of the rule in CLAUDE.md. Model and effort are
 * placeholders in the agent's env template, filled at spawn — so before the
 * process exists they are ours to set freely, and the profile catalog is the
 * only place that knows what the choices are. The moment the first message
 * creates the session this control is replaced by SessionConfigPopover and the
 * agent's own ACP selectors take over.
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
  const { personas, profile, agent, agentProfiles, configure } = useDraft(meta, actions, remember)
  const models = profile?.models ?? []
  const resolvedModel = models.find((m) => m.id === (meta.model || profile?.defaultModel))

  /* What this profile's agent offered the last time one ran. A draft has no
     process to ask, so this is the only way its settings can be picked before
     the thread starts; `createSession` replays the picks once session/new
     answers. No modeIds here: without a live session there is no separate
     `modes` state for a mode option to duplicate, so it renders as itself.
     Siblings of the same agent stand in while this profile has no answer of
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
  const remembered = React.useMemo(() => {
    const modelOption = known.base.find((o) => o.category === "model" && o.type === "select")
    const chosen = modelOption ? meta.configChoices?.[modelOption.id] : undefined
    return withChoices(
      optionsForModel(known, typeof chosen === "string" ? chosen : undefined),
      meta.configChoices
    )
  }, [known, meta.configChoices])
  const agentOptions = partitionSessionOptions(remembered)

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
  const modelLabel = overridden
    ? (resolvedModel?.label ?? (meta.model || "Profile default"))
    : agentOptions.model
      ? (selectChoices(agentOptions.model).find((c) => c.value === optionValue(agentOptions.model))
          ?.name ?? (profile?.name ?? "Agent"))
      : (profile?.name ?? "Agent")
  const effortLabel = profileEffort
    ? meta.effort || null
    : liveEffort
      ? (selectChoices(liveEffort).find((c) => c.value === optionValue(liveEffort))?.name ?? null)
      : null

  const choose = (configId: string, value: string | boolean) =>
    actions.chooseDraftConfigOption(meta.id, configId, value)
  const nothingYet = !overridden && remembered.length === 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            /* Ellipsized rather than collapsed, on a phone as in a narrow dock
               panel — same rule as SessionConfigPopover's trigger, which
               replaces this one the moment the thread starts. */
            className="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent"
            title={[persona?.name, modelLabel, effortLabel].filter(Boolean).join(" · ")}
          >
            {/* The model's own icon replaces the profile's logo in the pair —
                the two marks stay, it is only the second one that changes. A
                broken model icon falls back to the profile logo, which is what
                would have shown anyway. */}
            {resolvedModel?.iconUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-composer" />
                <EntityIcon
                  src={resolvedModel.iconUrl}
                  fallback={
                    <ProfileIcon
                      profile={profile}
                      agentId={agent?.id ?? meta.agentId}
                      className="size-4 ring-2 ring-composer"
                    />
                  }
                  className="size-4 ring-2 ring-composer"
                />
              </AvatarGroup>
            ) : profile?.logoUrl ? (
              <AvatarGroup className="-space-x-1">
                <AgentIcon agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-composer" />
                <ProfileIcon profile={profile} agentId={agent?.id ?? meta.agentId} className="size-4 ring-2 ring-composer" />
              </AvatarGroup>
            ) : (
              <ProfileIcon profile={profile} agentId={agent?.id ?? meta.agentId} className="size-4" />
            )}
            <span className="max-w-56 truncate">
              {persona && <span>{persona.name} · </span>}
              {modelLabel}
              {effortLabel && <span className="capitalize"> · {effortLabel}</span>}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Start this thread with</DropdownMenuLabel>
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
                ...models.map((m) => ({ value: m.id, name: m.label })),
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
                choices={selectChoices(agentOptions.model)}
                onSelect={(value) => choose(agentOptions.model!.id, value)}
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
                onSelect={(value) => choose(liveEffort.id, value)}
              />
            )
          )}
          {nothingYet && (
            <DropdownMenuItem disabled className="whitespace-normal text-xs">
              {profile
                ? `${profile.name} lets the agent choose. Its settings appear here once this agent has run once.`
                : "Pick a profile to start this thread."}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {/* Never touched by the profile: mode and the rest are the agent's, and
            they stay exactly where they are whichever profile is selected. */}
        {agentOptions.rest.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent options</DropdownMenuLabel>
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
