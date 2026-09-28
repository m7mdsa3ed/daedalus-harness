/**
 * The tools menu itself: the trigger that states the count, and the popup that
 * holds the three submenus. It owns everything that is about *the thread* —
 * which links are the profile's, which are its own, what a toggle writes, and
 * whether the runtime will read them at all — and hands each submenu only the
 * slice it draws.
 */
import { BlocksIcon, ServerIcon, SlashSquareIcon, WrenchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownMenuContentPositioned } from "@/components/ui-ext/dropdown-menu"
import {
  READING_MARK,
  READING_TRIGGER,
  ReadingBubble,
  ReadingFace,
} from "@/components/composer/indicator"
import type { Actions } from "@/lib/actions"
import { mcpNeedsAuth, mcpSubtitle, type SessionMeta } from "@/lib/settings"
import { useAgents, useCommands, useMcpServers, useProfiles, useSkills } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"

import { ToolSection } from "./tool-section"
import { useThreadToolCount } from "./use-thread-tool-count"

/** The three link kinds, in the order the menu prints them. */
type LinkKey = "mcpServerIds" | "skillIds" | "commandIds"

/**
 * What this thread brings with it: MCP servers, skills and slash commands out
 * of the library, on top of whatever its profile already links.
 *
 * One component for both halves of a thread's life, because the question is the
 * same one either side of the first message — *what is this thread carrying* —
 * and answering it only while the thread was a draft meant the picks vanished
 * at the moment they started mattering.
 *
 *   - **On a draft it is a picker.** The profile's are shown checked and locked
 *     (they are the provider's, set in Settings, and a thread cannot opt out of
 *     them here), so the thread's own picks are exactly the additions. They
 *     travel with `POST /api/sessions` and the agent is spawned with the union.
 *   - **On a started thread it is a read-out.** The links are written once at
 *     create and are what a revive spawns with, so there is nothing to toggle;
 *     it lists what is loaded and where each entry came from. It renders
 *     nothing at all when the thread carries none, since a control that only
 *     ever says "No tools" is a control worth not drawing.
 *
 * **The three kinds are submenus, not three stacked groups.** A library grows —
 * a dozen MCP servers, a shelf of skills, every slash command — and one flat
 * popup made the whole thing a scroll: the group you wanted was below the fold,
 * and picking one server meant reading past every skill to be sure you had.
 * The root is three rows now, each saying how many of that kind the thread is
 * carrying and out of how many it could, so the count is legible without
 * opening anything and the list you open is only the one you asked for.
 *
 * The project contributes nothing in either mode: it is the directory, not the
 * toolset.
 */
export function ThreadToolsMenu({
  meta,
  actions,
  editable,
  className,
  remember = true,
  side = "top",
}: {
  meta: SessionMeta
  actions: Actions
  /** A draft can still choose; a started thread's links are already spawned. */
  editable: boolean
  className?: string
  /** Which way the popup opens. The caller's, not this component's: the same
      menu sits in the composer's band (bottom of the panel, opens upward) and
      on the routine form (a page, where it is pinned below). It used to be
      read off `editable`, which was only ever a proxy for *where the trigger
      was standing* — and the moment a draft's row moved into the composer,
      that proxy pointed the draft's menu off the bottom of the screen. */
  side?: "top" | "bottom"
  /** False when this menu is editing a saved configuration rather than the
      draft you are about to send (a routine's kit) — see DraftScopeRow. */
  remember?: boolean
}) {
  /* Four catalog reads, each its own cache entry: this menu is in the
     composer row of a live transcript, and nothing the transcript streams
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
     the next thread starts with the same kit — `configureDraft` writes the
     project's defaults, and `remember: false` withholds that for a caller
     configuring a routine rather than the thread you are about to start. */
  const toggle = (key: LinkKey, id: string, on: boolean) => {
    const next = on ? [...own[key].filter((x) => x !== id), id] : own[key].filter((x) => x !== id)
    actions.configureDraft(meta.id, { [key]: next }, remember)
  }
  const extra = own.mcpServerIds.length + own.skillIds.length + own.commandIds.length
  const total = useThreadToolCount(meta)

  /* Only an MCP row can need one; the generic section renderer is handed a
     predicate rather than learning what a server is. */
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

  // Nothing to read out, so nothing on the composer row.
  if (!editable && total === 0) return null

  const iconClass = "size-4 text-muted-foreground"
  /* One string for the title and the accessible name, since the trigger's
     words are its own (`Tools` and a count) rather than the whole answer. */
  const countLabel = `${editable ? "Tools for this thread" : "Tools this thread is running with"} — ${
    total === 0 ? "none" : `${total} tool${total === 1 ? "" : "s"}`
  }${editable && extra > 0 ? ` (+${extra} added here)` : ""}`
  /* The count in words where the panel has room, riding the mark where it does
     not — the bargain every reading of the thread strikes, because it is the
     same *kind* of question: what this thread answers with, glanced at
     constantly and read in full rarely. Two dresses of one count, never both.
     A phrase rather than a bare glyph because "12 tools" says what the 12 *are*
     — the wrench alone is the one thing in the cluster a reader has to decode. */
  const toolsLabel = total === 0 ? "No tools" : `${total} tool${total === 1 ? "" : "s"}`
  /* What every section needs and none of them decides for itself. */
  const common = { editable, needsAuth, agentName: agent?.name }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          /* A reading, like the four beside it rather than a bare glyph: the
             words say *what* the count counts, which a wrench alone does not.
             It stands in the footer's end cluster, not on the row's start —
             `DraftScopeRow` places it — because "what this thread carries" is a
             fact about the thread, the same as how full its window is. */
          <Button
            variant="ghost"
            size="icon-xs"
            title={countLabel}
            aria-label={countLabel}
            className={cn(READING_TRIGGER, "text-muted-foreground hover:text-foreground", className)}
          >
            {/* The mark rides inside the pill. The other dress of the same
                count is the bubble, withheld at zero — a `0` on the mark reads
                as a broken reading, where "No tools" on the wide panel is
                simply the answer. */}
            <ReadingFace
              icon={<WrenchIcon className={READING_MARK} />}
              label={toolsLabel}
              after={
                total > 0 ? <ReadingBubble>{total > 9 ? "9+" : total}</ReadingBubble> : null
              }
            />
          </Button>
        }
      />
      {/* Pinned below rather than flipping, when the caller asks to open that
          way: the popup already sizes itself to the room it has and scrolls, so
          on a form page keeping the side fixed costs nothing and keeps the
          menus in that column opening alike. Upward — the composer's case, and
          the default — flips as normal, because a trigger at the bottom of the
          panel has no room under it. */}
      <DropdownMenuContentPositioned
        align="start"
        side={side}
        collisionAvoidance={
          side === "bottom" ? { side: "none", fallbackAxisSide: "none" } : undefined
        }
        className="w-56"
      >
        {/* The label is Base UI's Menu.GroupLabel: it reads its group from
            context and throws outside one, so it sits inside the group it
            heads rather than loose in the content. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {editable ? "Tools for this thread" : "Running with"}
          </DropdownMenuLabel>
          <ToolSection
            {...common}
            title="MCP servers"
            icon={<ServerIcon className={iconClass} />}
            items={mcpServers.filter((server) => server.type !== "builtin")}
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
        </DropdownMenuGroup>
        {/* Only offered when there is something of the thread's own to take
            back: the profile's links are not this menu's to clear. */}
        {editable && extra > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                actions.configureDraft(
                  meta.id,
                  { mcpServerIds: [], skillIds: [], commandIds: [] },
                  remember
                )
              }
            >
              Clear this thread&rsquo;s picks
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContentPositioned>
    </DropdownMenu>
  )
}
