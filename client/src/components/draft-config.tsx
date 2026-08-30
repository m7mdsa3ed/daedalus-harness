import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { BotIcon, WrenchIcon } from "lucide-react"
import { AgentIcon, ProfileIcon, ProjectIcon } from "@/components/entity-icon"
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
import type { Actions } from "@/lib/actions"
import { optionKey, optionsForModel, useAgentOptions, withChoices } from "@/lib/agent-options"
import { partitionSessionOptions } from "@/lib/session-options"
import { mcpSubtitle, profileSupports, type SessionMeta } from "@/lib/settings"
import { saveThreadDefaults } from "@/lib/thread-defaults"
import { useStore } from "@/lib/store"

const DEFAULT_CHOICE = "__default__"

/** The shared read of a draft's current configuration — both controls below
    need the same lookups, and they must not disagree about what is selected. */
function useDraft(meta: SessionMeta, actions: Actions) {
  const { state } = useStore()
  const project = state.projects.find((p) => p.id === meta.projectId)
  const profile = state.profiles.find((p) => p.id === meta.profileId)
  // The draft's own agent, not the profile's: a profile may serve several.
  const agent = state.agents.find((a) => a.id === meta.agentId)
  /* The profiles this thread could run on — every one configured for its
     agent. The profile only overrides model and effort; the agent is what the
     rest of the menu belongs to, so switching profile keeps it. */
  const agentProfiles = state.profiles.filter((p) => profileSupports(p, meta.agentId))

  const configure = (next: Parameters<Actions["configureDraft"]>[1]) => {
    actions.configureDraft(meta.id, next)
    // Remembered for the next new thread: the agent you reach for is a habit,
    // not a decision worth making twice.
    saveThreadDefaults({
      projectId: next.projectId ?? meta.projectId,
      profileId: next.profileId ?? meta.profileId,
      agentId: next.agentId ?? meta.agentId,
      model: next.model ?? meta.model,
      effort: next.effort ?? meta.effort,
    })
  }

  return { state, project, profile, agent, agentProfiles, configure }
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
export function DraftScopeRow({ meta, actions }: { meta: SessionMeta; actions: Actions }) {
  const { state, project, profile, agent, configure } = useDraft(meta, actions)

  /* On the strip's collapsed line this row is its two answers: which agent will
     take the thread, and which project it will run in. That is the whole point
     of the row, so the summary says it outright rather than "Draft settings". */
  useStripSummary({
    id: "scope",
    icon: BotIcon,
    label: `${agent?.name ?? "No agent"} · ${project?.name ?? "No project"}`,
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
        : state.profiles.find((p) => profileSupports(p, agentId))
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
        options={state.agents.map((a) => ({
          value: a.id,
          name: a.name,
          icon: <AgentIcon agentId={a.id} className="size-4" />,
        }))}
        onSelect={chooseAgent}
      />
      {divider}
      <PickerMenu
        icon={<ProjectIcon project={project} className="size-3.5" />}
        label={project?.name ?? "No project"}
        title="Project"
        value={project?.id ?? ""}
        options={state.projects.map((p) => ({
          value: p.id,
          name: p.name,
          hint: p.cwd,
          icon: <ProjectIcon project={p} className="size-4" />,
        }))}
        onSelect={(id) => configure({ projectId: id })}
      />
      {divider}
      <DraftToolsMenu meta={meta} actions={actions} />
    </div>
  )
}

/**
 * What this thread brings with it: MCP servers, skills and slash commands out
 * of the library, on top of whatever its profile already links.
 *
 * The profile's are shown checked and locked — they are the provider's, set
 * in Settings, and a thread cannot opt out of them here — so the thread's own
 * picks are exactly the additions. They travel with `POST /api/sessions`, and
 * the agent is spawned with the union. The project contributes nothing: it is
 * the directory, not the toolset.
 */
function DraftToolsMenu({ meta, actions }: { meta: SessionMeta; actions: Actions }) {
  const { state, profile } = useDraft(meta, actions)
  const inherited = {
    mcpServerIds: new Set(profile?.mcpServerIds ?? []),
    skillIds: new Set(profile?.skillIds ?? []),
    commandIds: new Set(profile?.commandIds ?? []),
  }
  const own = {
    mcpServerIds: meta.mcpServerIds ?? [],
    skillIds: meta.skillIds ?? [],
    commandIds: meta.commandIds ?? [],
  }
  const toggle = (key: keyof typeof own, id: string, on: boolean) =>
    actions.configureDraft(meta.id, {
      [key]: on ? [...own[key].filter((x) => x !== id), id] : own[key].filter((x) => x !== id),
    })
  const extra = own.mcpServerIds.length + own.skillIds.length + own.commandIds.length
  const total =
    extra + inherited.mcpServerIds.size + inherited.skillIds.size + inherited.commandIds.size

  const group = <T extends { id: string; name: string }>(
    title: string,
    key: keyof typeof own,
    items: T[],
    hint: (item: T) => string
  ) => (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{title}</DropdownMenuLabel>
      {items.length === 0 ? (
        <DropdownMenuItem disabled className="text-xs">
          None in the library.
        </DropdownMenuItem>
      ) : (
        items.map((item) => {
          const from = inherited[key].has(item.id)
          return (
            <DropdownMenuCheckboxItem
              key={item.id}
              checked={from || own[key].includes(item.id)}
              disabled={from}
              closeOnClick={false}
              onCheckedChange={(checked) => toggle(key, item.id, checked === true)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{item.name}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {from ? "from profile" : hint(item)}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          )
        })
      )}
    </DropdownMenuGroup>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            title="Tools for this thread"
            className="h-6 min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent/50"
          >
            <WrenchIcon className="size-3.5" />
            <span className="max-w-40 truncate">
              {total === 0 ? "No tools" : `${total} tool${total === 1 ? "" : "s"}`}
              {extra > 0 && ` (+${extra})`}
            </span>
          </Button>
        }
      />
      {/* Pinned below the strip rather than flipping above it: the popup
          already sizes itself to the room it has and scrolls, so keeping the
          side fixed costs nothing and keeps the three menus on the strip
          opening the same way. */}
      <DropdownMenuContent
        align="start"
        side="bottom"
        collisionAvoidance={{ side: "none", fallbackAxisSide: "none" }}
        className="w-64"
      >
        {group("MCP servers", "mcpServerIds", state.mcpServers, mcpSubtitle)}
        <DropdownMenuSeparator />
        {group("Skills", "skillIds", state.skills, (s) => s.path)}
        <DropdownMenuSeparator />
        {group("Slash commands", "commandIds", state.commands, (c) => `/${c.name}`)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One inline picker on the strip: icon, current value, menu. */
function PickerMenu({
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
}: {
  meta: SessionMeta
  actions: Actions
}) {
  const { profile, agent, agentProfiles, configure } = useDraft(meta, actions)
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
            /* Icon-only on a phone — same collapse as SessionConfigPopover's
               trigger, which replaces this one the moment the thread starts. */
            className="h-8 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent data-popup-open:bg-transparent max-md:w-8 max-md:px-0"
            title={[modelLabel, effortLabel].filter(Boolean).join(" · ")}
          >
            {/* Same rule as SessionConfigPopover's trigger: the profile's own
                logo when it has one, the agent's mark otherwise. */}
            <ProfileIcon profile={profile} agentId={agent?.id ?? meta.agentId} className="size-4" />
            <span className="max-w-56 truncate max-md:sr-only">
              {modelLabel}
              {effortLabel && <span className="capitalize"> · {effortLabel}</span>}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Start this thread with</DropdownMenuLabel>
          {/* First, and above Model on purpose: the model and effort lists below
              are this profile's, so which profile is selected decides what they
              can even contain. */}
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
