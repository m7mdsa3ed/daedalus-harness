import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import { BotIcon, FolderIcon } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
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
import type { Actions } from "@/lib/actions"
import { optionsForModel, useAgentOptions, withChoices } from "@/lib/agent-options"
import { partitionSessionOptions } from "@/lib/session-options"
import type { SessionMeta } from "@/lib/settings"
import { saveThreadDefaults } from "@/lib/thread-defaults"
import { useStore } from "@/lib/store"

const DEFAULT_CHOICE = "__default__"

/** The shared read of a draft's current configuration — both controls below
    need the same lookups, and they must not disagree about what is selected. */
function useDraft(meta: SessionMeta, actions: Actions) {
  const { state } = useStore()
  const project = state.projects.find((p) => p.id === meta.projectId)
  const profile = state.profiles.find((p) => p.id === meta.profileId)
  const agent = state.agents.find((a) => a.id === profile?.agentId)

  const configure = (next: Parameters<Actions["configureDraft"]>[1]) => {
    actions.configureDraft(meta.id, next)
    // Remembered for the next new thread: the agent you reach for is a habit,
    // not a decision worth making twice.
    saveThreadDefaults({
      projectId: next.projectId ?? meta.projectId,
      profileId: next.profileId ?? meta.profileId,
      model: next.model ?? meta.model,
      effort: next.effort ?? meta.effort,
    })
  }

  return { state, project, profile, agent, configure }
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
  const { state, project, agent, configure } = useDraft(meta, actions)

  /* Switching agent means switching profile: a profile belongs to exactly one
     agent, and the model ids belong to the profile. Carrying either across
     would name something the new agent has never heard of. */
  const chooseAgent = (agentId: string) => {
    const next = state.profiles.find((p) => p.agentId === agentId)
    if (!next) return
    configure({ agentId, profileId: next.id, model: "", effort: "" })
  }

  const divider = <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <PickerMenu
        icon={<BotIcon className="size-3.5" />}
        label={agent?.name ?? "No agent"}
        title="Agent"
        value={agent?.id ?? ""}
        options={state.agents.map((a) => ({ value: a.id, name: a.name }))}
        onSelect={chooseAgent}
      />
      {divider}
      <PickerMenu
        icon={<FolderIcon className="size-3.5" />}
        label={project?.name ?? "No project"}
        title="Project"
        value={project?.id ?? ""}
        options={state.projects.map((p) => ({ value: p.id, name: p.name, hint: p.cwd }))}
        onSelect={(id) => configure({ projectId: id })}
      />
    </div>
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
  options: { value: string; name: string; hint?: string }[]
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
  const { state, profile, agent, configure } = useDraft(meta, actions)
  const agentProfiles = state.profiles.filter((p) => p.agentId === profile?.agentId)
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
    meta.profileId,
    agentProfiles.filter((p) => p.id !== meta.profileId).map((p) => p.id)
  )
  /* Ask this profile's agent directly, once ever — the action no-ops when its
     own set is already known or the question is in flight. A sibling's set
     above fills the menu meanwhile, but does not answer for this profile's
     env: a different endpoint can carry a different catalog. */
  React.useEffect(() => {
    void actions.learnAgentOptions(meta.profileId, meta.projectId)
  }, [actions, meta.profileId, meta.projectId])
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
            <AgentIcon agentId={agent?.id ?? profile?.agentId} className="size-4" />
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
              choices={agentProfiles.map((p) => ({ value: p.id, name: p.name }))}
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
