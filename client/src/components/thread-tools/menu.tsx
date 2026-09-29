/**
 * What a thread carries and what it could: MCP servers, skills and slash
 * commands out of the library, as a group of submenus in the thread's settings
 * dropdown. This owns everything that is about *the thread* — which links are
 * its own, what a toggle writes, and whether the runtime will read them at all.
 *
 * **The kinds are submenus, not stacked groups**: a library grows, and one flat
 * popup made picking one server mean reading past every skill. Each row says
 * how many of its kind the thread carries, out of how many it could.
 *
 *   - **On a draft it is a picker.** The picks travel with `POST /api/sessions`
 *     and the agent is spawned with them.
 *   - **On a started thread it is a read-out.** The links are written once at
 *     create and are what a revive spawns with, so there is nothing to toggle.
 *
 * The project contributes nothing: it is the directory, not the toolset.
 */
import { BlocksIcon, ServerIcon, SlashSquareIcon, WrenchIcon } from "lucide-react"

import { McpIcon } from "@/components/entity-icon"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import type { Actions } from "@/lib/actions"
import { mcpNeedsAuth, mcpSubtitle, type SessionMeta } from "@/lib/settings"
import { useAgents, useCommands, useMcpServers, useSkills } from "@/lib/queries/catalog"

import { ToolSection } from "./tool-section"

/** The three link kinds. */
export type LinkKey = "mcpServerIds" | "skillIds" | "commandIds"

export function useThreadToolLinks(meta: SessionMeta, actions: Actions, remember = true) {
  /* Catalog reads, each its own cache entry: nothing the transcript streams
     touches any of them. */
  const mcpServers = useMcpServers()
  const skills = useSkills()
  const commands = useCommands()
  // Profiles carry no links; nothing is inherited.
  const inherited: Record<LinkKey, Set<string>> = {
    mcpServerIds: new Set<string>(),
    skillIds: new Set<string>(),
    commandIds: new Set<string>(),
  }
  const own: Record<LinkKey, string[]> = {
    mcpServerIds: meta.mcpServerIds ?? [],
    skillIds: meta.skillIds ?? [],
    commandIds: meta.commandIds ?? [],
  }
  /* Published like the agent is: a reload rebuilds the draft from these, and
     the next thread starts with the same kit — `remember: false` withholds that
     for a caller configuring a routine rather than the thread you are about to
     start. */
  const toggle = (key: LinkKey, id: string, on: boolean) => {
    const next = on ? [...own[key].filter((x) => x !== id), id] : own[key].filter((x) => x !== id)
    actions.configureDraft(meta.id, { [key]: next }, remember)
  }

  /* Only an MCP row can need one. */
  const needsAuth = (item: { id: string }): boolean => {
    const server = mcpServers.find((s) => s.id === item.id)
    return !!server && mcpNeedsAuth(server)
  }

  /* Whether this thread's runtime reads skills or commands out of the
     workspace at all (`AgentDef.workspaceLayout`). A runtime that names no
     directory — Codex, which resolves both only under `$CODEX_HOME` — is written
     none, and a pick that lands nowhere must not look like one that works.
     Unknown (the catalog has not answered yet) is not "unsupported". */
  const agent = useAgents().find((a) => a.id === meta.agentId)
  const unreadable = (key: LinkKey): string | null => {
    if (!agent) return null
    if (key === "skillIds" && !agent.workspaceLayout?.skills) return "skills"
    if (key === "commandIds" && !agent.workspaceLayout?.commands) return "commands"
    return null
  }

  return { mcpServers, skills, commands, inherited, own, toggle, needsAuth, agent, unreadable }
}

/** The tools group of a settings dropdown: four submenus and, on a draft that
    has picked some, the way to take them back. Renders nothing on a started
    thread that carries none — a group that only ever says "none" is not worth
    drawing. */
export function ThreadToolsSections({
  meta,
  actions,
  editable,
  remember = true,
}: {
  meta: SessionMeta
  actions: Actions
  /** A draft can still choose; a started thread's links are already spawned. */
  editable: boolean
  remember?: boolean
}) {
  const { mcpServers, skills, commands, inherited, own, toggle, needsAuth, agent, unreadable } =
    useThreadToolLinks(meta, actions, remember)
  const extra = own.mcpServerIds.length + own.skillIds.length + own.commandIds.length
  if (!editable && extra === 0) return null
  const iconClass = "size-4 text-muted-foreground"
  const common = { editable, needsAuth, agentName: agent?.name }
  return (
    <>
    <DropdownMenuSeparator />
    <DropdownMenuGroup>
      <DropdownMenuLabel>{editable ? "Tools" : "Running with"}</DropdownMenuLabel>
      <ToolSection
        {...common}
        title="MCP servers"
        icon={<ServerIcon className={iconClass} />}
        items={mcpServers.filter((server) => server.type !== "builtin")}
        itemIcon={(server) => <McpIcon server={server} className="size-3.5" />}
        hint={mcpSubtitle}
        inherited={inherited.mcpServerIds}
        own={own.mcpServerIds}
        unreadable={unreadable("mcpServerIds")}
        onToggle={(id, on) => toggle("mcpServerIds", id, on)}
      />
      <ToolSection
        {...common}
        title="Built-in tools"
        icon={<WrenchIcon className={iconClass} />}
        items={mcpServers.filter((server) => server.type === "builtin")}
        itemIcon={(server) => <McpIcon server={server} className="size-3.5" />}
        hint={mcpSubtitle}
        inherited={inherited.mcpServerIds}
        own={own.mcpServerIds}
        unreadable={unreadable("mcpServerIds")}
        onToggle={(id, on) => toggle("mcpServerIds", id, on)}
      />
      <ToolSection
        {...common}
        title="Skills"
        icon={<BlocksIcon className={iconClass} />}
        items={skills}
        hint={(s) => s.path}
        inherited={inherited.skillIds}
        own={own.skillIds}
        unreadable={unreadable("skillIds")}
        onToggle={(id, on) => toggle("skillIds", id, on)}
      />
      <ToolSection
        {...common}
        title="Slash commands"
        icon={<SlashSquareIcon className={iconClass} />}
        items={commands}
        hint={(c) => `/${c.name}`}
        inherited={inherited.commandIds}
        own={own.commandIds}
        unreadable={unreadable("commandIds")}
        onToggle={(id, on) => toggle("commandIds", id, on)}
      />
      {/* Only when there is something of the thread's own to take back. */}
      {editable && extra > 0 && (
        <DropdownMenuItem
          onClick={() =>
            actions.configureDraft(meta.id, { mcpServerIds: [], skillIds: [], commandIds: [] }, remember)
          }
        >
          Clear this thread&rsquo;s tools
        </DropdownMenuItem>
      )}
    </DropdownMenuGroup>
    </>
  )
}
