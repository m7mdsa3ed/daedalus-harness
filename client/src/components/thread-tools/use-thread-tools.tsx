/**
 * Everything about *the thread's* tools that a surface drawing them needs and
 * must not decide for itself: which links are the profile's, which are its
 * own, what a toggle writes, and whether the runtime will read them at all.
 *
 * The dropdown (`ThreadToolsMenu`) and the inline panel (`ThreadToolsPanel`)
 * both read it, so the two differ only in how they draw a section — never in
 * what a pick writes or which rows a started thread lists.
 */
import * as React from "react"
import { BlocksIcon, ServerIcon, SlashSquareIcon, WrenchIcon } from "lucide-react"

import type { Actions } from "@/lib/actions"
import { mcpNeedsAuth, mcpSubtitle, type SessionMeta } from "@/lib/settings"
import { useAgents, useCommands, useMcpServers, useSkills } from "@/lib/queries/catalog"

import { useThreadToolCount } from "./use-thread-tool-count"

/** The three link kinds. */
export type LinkKey = "mcpServerIds" | "skillIds" | "commandIds"

/** One kind of tool, as every surface draws it: a title, an icon, a library and
    the thread's links for that kind — handed as a set and a list rather than a
    `LinkKey`, so the drawing never learns which kind it is. */
export type ToolSectionModel = {
  title: string
  icon: React.ReactNode
  items: { id: string; name: string }[]
  hint: (item: { id: string; name: string }) => string
  /** Linked by the profile: checked, locked, and not this surface's to clear. */
  inherited: Set<string>
  /** Linked by the thread itself. */
  own: string[]
  /** What this runtime does not read out of the workspace, in words
      ("skills"), or null when it reads this kind. */
  unreadable: string | null
  onToggle: (id: string, on: boolean) => void
}

export function useThreadTools(meta: SessionMeta, actions: Actions, remember: boolean) {
  /* Four catalog reads, each its own cache entry: this sits in the composer
     of a live transcript, and nothing the transcript streams touches any of
     them. */
  const mcpServers = useMcpServers()
  const skills = useSkills()
  const commands = useCommands()
  // Profiles carry no links; nothing is inherited.
  const inherited = new Set<string>()
  const own: Record<LinkKey, string[]> = {
    mcpServerIds: meta.mcpServerIds ?? [],
    skillIds: meta.skillIds ?? [],
    commandIds: meta.commandIds ?? [],
  }
  /* Published like the agent is: a reload rebuilds the draft from these, and
     the next thread starts with the same kit — `configureDraft` writes the
     project's defaults, and `remember: false` withholds that for a caller
     configuring a routine rather than the thread you are about to start. */
  const toggle = (key: LinkKey, id: string, on: boolean) => {
    const next = on ? [...own[key].filter((x) => x !== id), id] : own[key].filter((x) => x !== id)
    actions.configureDraft(meta.id, { [key]: next }, remember)
  }
  /** Takes back the thread's own picks; the profile's are not this surface's
      to clear. */
  const clear = () =>
    actions.configureDraft(meta.id, { mcpServerIds: [], skillIds: [], commandIds: [] }, remember)
  const extra = own.mcpServerIds.length + own.skillIds.length + own.commandIds.length
  const total = useThreadToolCount(meta)

  /* Only an MCP row can need one; the generic section is handed a predicate
     rather than learning what a server is. */
  const needsAuth = (item: { id: string }): boolean => {
    const server = mcpServers.find((s) => s.id === item.id)
    return !!server && mcpNeedsAuth(server)
  }

  /* Whether this thread's runtime reads skills or commands out of the
     workspace at all (`AgentDef.workspaceLayout`). The harness writes them
     into the directory the runtime names, and a runtime that names none —
     Codex, which resolves both only under `$CODEX_HOME` — is written none. A
     pick that lands nowhere used to look exactly like one that works, which is
     the whole reason this is said out loud rather than left as a silence.
     Unknown (the catalog has not answered yet) is not "unsupported": it stays
     quiet rather than nagging about a thread that is fine. */
  const agent = useAgents().find((a) => a.id === meta.agentId)
  const unreadable = (key: LinkKey): string | null => {
    if (!agent) return null
    if (key === "skillIds" && !agent.workspaceLayout?.skills) return "skills"
    if (key === "commandIds" && !agent.workspaceLayout?.commands) return "commands"
    return null
  }

  const iconClass = "size-4 text-muted-foreground"
  const section = <T extends { id: string; name: string }>(
    key: LinkKey,
    rest: { title: string; icon: React.ReactNode; items: T[]; hint: (item: T) => string }
  ): ToolSectionModel => ({
    ...rest,
    // Only ever called with this section's own items.
    hint: rest.hint as ToolSectionModel["hint"],
    inherited,
    own: own[key],
    unreadable: unreadable(key),
    onToggle: (id, on) => toggle(key, id, on),
  })
  const sections: ToolSectionModel[] = [
    section("mcpServerIds", {
      title: "MCP servers",
      icon: <ServerIcon className={iconClass} />,
      items: mcpServers.filter((server) => server.type !== "builtin"),
      hint: mcpSubtitle,
    }),
    section("mcpServerIds", {
      title: "Built-in tools",
      icon: <WrenchIcon className={iconClass} />,
      items: mcpServers.filter((server) => server.type === "builtin"),
      hint: mcpSubtitle,
    }),
    section("skillIds", {
      title: "Skills",
      icon: <BlocksIcon className={iconClass} />,
      items: skills,
      hint: (s) => s.path,
    }),
    section("commandIds", {
      title: "Slash commands",
      icon: <SlashSquareIcon className={iconClass} />,
      items: commands,
      hint: (c) => `/${c.name}`,
    }),
  ]

  return { sections, extra, total, needsAuth, agentName: agent?.name, clear }
}

/**
 * What one section shows and counts. A draft offers the whole library to pick
 * from; a started thread lists only what it is actually running — the rest is
 * neither a choice it has nor a fact about it. `shown` is null when a started
 * thread carries none of this kind, which is a section not drawn at all.
 */
export function sectionView(s: ToolSectionModel, editable: boolean) {
  const has = (id: string) => s.inherited.has(id) || s.own.includes(id)
  const shown = editable ? s.items : s.items.filter((item) => has(item.id))
  if (!editable && shown.length === 0) return null
  const on = shown.filter((item) => has(item.id)).length
  /* The count is the point of the row: "2 of 9" while picking, a bare figure
     once the thread has spawned and the library is no longer a choice. */
  const count = editable ? (on === 0 ? `${shown.length}` : `${on} of ${shown.length}`) : `${on}`
  return { shown, has, count }
}

/** An entry's second line: the one thing a reader needs to know about where it
    stands, in priority order. An OAuth server nobody has connected resolves to
    nothing at spawn — it is not advertised at all — so that outranks
    everything. */
export function rowSubtitle(needsAuth: boolean, from: boolean, hint: string): string {
  return needsAuth ? "needs authorization — Settings › MCP servers" : from ? "from profile" : hint
}

/** The note a section carries when the runtime will not read what it links. */
export function unreadableNote(agentName: string | undefined, unreadable: string): string {
  return `${agentName} does not read ${unreadable} from the project — these are linked, but it will not see them.`
}
