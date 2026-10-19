import * as React from "react"
import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react"

import {
  AgentRequestActions,
  AgentRequestBody,
  AgentRequestCard,
  AgentRequestHeader,
  REQUEST_BUTTON,
} from "@/components/agent-request"
import { MenuRow } from "@/components/config-menu"
import { AgentIcon, ModelIcon, ProfileIcon } from "@/components/entity-icon"
import { Button } from "@/components/ui/button"
import {
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useAgents, useAgentsStatus, useProfiles } from "@/lib/queries/catalog"
import { profileSupports, type AskChoice, type AskProfiles, type Profile } from "@/lib/settings"
import { cn } from "@/lib/utils"

/* ── Which profile (and model) `ask_agent` uses, per agent ──
   One vocabulary in two places: the config menus' "Ask agents" submenu, where
   the person sets it ahead of time, and the card the `agents` MCP server raises
   when an ask has nothing set (an MCP form elicitation whose `askAgentPair`
   field this file recognises). Both draw the config menu's own Profile and
   Model rows, so a pick reads the same wherever it is made. */

/** The elicitation field the card is recognised by, and the answer's keys —
    mirrored by `server/src/agents-mcp.ts`. A key survives every bridge that a
    schema annotation might not. */
export const ASK_PAIR_FIELD = "askAgentPair"
const ASK_MODEL_FIELD = "askAgentModel"
const ASK_REMEMBER_FIELD = "askAgentRemember"

const ASK = "__ask__"
const DEFAULT = "__default__"

interface AskAgent {
  id: string
  name: string
  profiles: Profile[]
}

/** The agents an ask can reach: installed, each with the shown profiles that
    can run it — the list the server validates a pick against. */
function useAskAgents(): AskAgent[] {
  const agents = useAgents()
  const profiles = useProfiles()
  const status = useAgentsStatus().status
  return React.useMemo(() => {
    const installed = new Set(status?.agents.filter((a) => a.installed).map((a) => a.agentId))
    return agents
      .filter((a) => installed.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        profiles: profiles.filter((p) => profileSupports(p, a.id) && !p.hidden && !p.disabled),
      }))
      .filter((a) => a.profiles.length > 0)
  }, [agents, profiles, status])
}

/** The Profile and Model rows for one agent. A new profile starts on its own
    default model: a model id belongs to the catalog it came from. */
function AskRows({
  agent,
  choice,
  optional,
  onChange,
}: {
  agent: AskAgent
  choice?: AskChoice
  /** Offer "Ask me each time" — the settings menu can clear a choice, the card cannot. */
  optional?: boolean
  onChange: (next: AskChoice | null) => void
}) {
  const profile = agent.profiles.find((p) => p.id === choice?.profileId)
  return (
    <>
      <MenuRow
        label="Profile"
        value={profile?.id ?? ASK}
        choices={[
          ...(optional ? [{ value: ASK, name: "Ask me each time" }] : []),
          ...agent.profiles.map((p) => ({
            value: p.id,
            name: p.name,
            icon: <ProfileIcon profile={p} agentId={agent.id} className="size-4" />,
          })),
        ]}
        onSelect={(value) => onChange(value === ASK ? null : { profileId: value })}
      />
      {profile && profile.models.length > 0 && (
        <MenuRow
          label="Model"
          value={choice?.model ?? DEFAULT}
          choices={[
            { value: DEFAULT, name: "Profile default" },
            ...profile.models.map((m) => ({
              value: m.id,
              name: m.label,
              icon: <ModelIcon iconUrl={m.iconUrl} className="size-4" />,
            })),
          ]}
          onSelect={(value) =>
            onChange({ profileId: profile.id, ...(value === DEFAULT ? {} : { model: value }) })
          }
        />
      )}
    </>
  )
}

/** "Ask agents" in a config menu: a row per installed agent, each opening its
    Profile and Model. An agent left on "Ask me each time" is asked about at the
    first ask that reaches it. */
export function AskAgentsSub({
  value,
  onChange,
}: {
  value: AskProfiles
  onChange: (next: AskProfiles) => void
}) {
  const agents = useAskAgents()
  if (agents.length === 0) return null
  const set = (agentId: string, next: AskChoice | null) => {
    const { [agentId]: _old, ...rest } = value
    onChange(next ? { ...rest, [agentId]: next } : rest)
  }
  const count = agents.filter((a) => value[a.id]).length
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">Ask agents</span>
        {count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-72 no-scrollbar">
          {agents.map((agent) => {
            const choice = value[agent.id]
            const profile = agent.profiles.find((p) => p.id === choice?.profileId)
            return (
              <DropdownMenuSub key={agent.id}>
                <DropdownMenuSubTrigger>
                  <AgentIcon agentId={agent.id} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <span className="max-w-28 truncate text-xs text-muted-foreground">
                    {profile ? profile.name : "Ask me"}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-w-80 no-scrollbar">
                    <AskRows
                      agent={agent}
                      choice={choice}
                      optional
                      onChange={(next) => set(agent.id, next)}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            )
          })}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}

/** The radio row the thread's question cards are made of (`QuestionnaireChoice`):
    a pill-rounded row, the picked one on the primary's tint. */
const ROW =
  "relative flex min-h-11 w-full items-center gap-3 rounded-4xl border px-4 py-2.5 text-start text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
const ROW_ON = "border-primary/40 bg-primary/10"
const ROW_OFF = "border-input hover:bg-input/40"

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border",
        on ? "border-primary bg-primary" : "border-input dark:bg-input/30"
      )}
    >
      {on && <span className="size-2 rounded-full bg-primary-foreground" />}
    </span>
  )
}

/** The card for an `askAgentPair` elicitation, drawn in the transcript where
    the turn stopped. Everything is on the card — agent, profile, model,
    remember — because a question the turn is blocked on should not hide its
    answers behind a menu. `pairs` are the options the server offered
    (installed pairs only; one agent when the model named it). */
export function AskAgentPicker({
  message,
  pairs,
  settle,
}: {
  message: string
  pairs: { profileId: string; agentId: string }[]
  settle: (response: { action: "accept"; content: Record<string, string | boolean> } | { action: "decline" }) => void
}) {
  const agents = useAgents()
  const profiles = useProfiles()
  const offered: AskAgent[] = React.useMemo(
    () =>
      [...new Set(pairs.map((p) => p.agentId))].map((id) => ({
        id,
        name: agents.find((a) => a.id === id)?.name ?? id,
        profiles: profiles.filter((p) => pairs.some((x) => x.agentId === id && x.profileId === p.id)),
      })),
    [pairs, agents, profiles]
  )
  const [agentId, setAgentId] = React.useState(pairs[0]?.agentId ?? "")
  const [choice, setChoice] = React.useState<AskChoice | undefined>(() =>
    pairs[0] ? { profileId: pairs[0].profileId } : undefined
  )
  const [remember, setRemember] = React.useState(true)
  const agent = offered.find((a) => a.id === agentId) ?? offered[0]
  const profile = agent?.profiles.find((p) => p.id === choice?.profileId)
  const model = profile?.models.find((m) => m.id === choice?.model)
  const defaultModel = profile?.models.find((m) => m.id === profile.defaultModel)

  const pickAgent = (id: string) => {
    setAgentId(id)
    const first = pairs.find((p) => p.agentId === id)
    setChoice(first ? { profileId: first.profileId } : undefined)
  }
  const submit = () =>
    agent &&
    profile &&
    settle({
      action: "accept",
      content: {
        [ASK_PAIR_FIELD]: JSON.stringify([profile.id, agent.id]),
        ...(choice?.model ? { [ASK_MODEL_FIELD]: choice.model } : {}),
        [ASK_REMEMBER_FIELD]: remember,
      },
    })

  return (
    <AgentRequestCard>
      <AgentRequestHeader icon={MessageCircleQuestionIcon} label="Ask another agent">
        {message}
      </AgentRequestHeader>
      <AgentRequestBody>
        <div className="flex flex-col gap-3.5">
          {offered.length > 1 && (
            <div role="radiogroup" aria-label="Agent" className="flex flex-wrap gap-1.5">
              {offered.map((a) => {
                const on = a.id === agent?.id
                return (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pickAgent(a.id)}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      on ? cn(ROW_ON, "text-foreground") : cn(ROW_OFF, "text-muted-foreground hover:text-foreground")
                    )}
                  >
                    <AgentIcon agentId={a.id} className="size-4" />
                    {a.name}
                  </button>
                )
              })}
            </div>
          )}

          {agent && (
            <div role="radiogroup" aria-label="Profile" className="flex flex-col gap-2">
              {agent.profiles.map((p) => {
                const on = p.id === profile?.id
                const fallback = p.models.find((m) => m.id === p.defaultModel)?.label ?? p.defaultModel
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setChoice({ profileId: p.id })}
                    className={cn(ROW, on ? ROW_ON : ROW_OFF)}
                  >
                    <RadioDot on={on} />
                    <ProfileIcon profile={p} agentId={agent.id} className="size-5" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {fallback || "The agent's own model"}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {profile && profile.models.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">Model</span>
              <Select
                value={choice?.model ?? DEFAULT}
                onValueChange={(value) =>
                  setChoice({ profileId: profile.id, ...(value && value !== DEFAULT ? { model: value } : {}) })
                }
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1 text-xs">
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      {(model ?? defaultModel) && (
                        <ModelIcon iconUrl={(model ?? defaultModel)?.iconUrl} className="size-4" />
                      )}
                      <span className="truncate">
                        {model?.label ?? `Profile default${defaultModel ? ` · ${defaultModel.label}` : ""}`}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>
                    Profile default{defaultModel ? ` · ${defaultModel.label}` : ""}
                  </SelectItem>
                  {profile.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        <ModelIcon iconUrl={m.iconUrl} className="size-4" />
                        {m.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2.5 text-xs text-muted-foreground">
            <Switch size="sm" checked={remember} onCheckedChange={setRemember} />
            Use this for every ask to {agent?.name ?? "this agent"} in this thread
          </label>
        </div>
      </AgentRequestBody>
      <AgentRequestActions>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(REQUEST_BUTTON, "text-muted-foreground")}
          onClick={() => settle({ action: "decline" })}
        >
          Don&apos;t answer
        </Button>
        <Button
          type="button"
          size="sm"
          className={cn(REQUEST_BUTTON, "ms-auto")}
          disabled={!agent || !profile}
          onClick={submit}
        >
          <CheckIcon aria-hidden className="size-3.5" />
          Ask {agent?.name ?? "agent"}
        </Button>
      </AgentRequestActions>
    </AgentRequestCard>
  )
}
