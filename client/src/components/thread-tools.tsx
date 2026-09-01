import * as React from "react"
import { BlocksIcon, ServerIcon, SlashSquareIcon, WrenchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownMenuContentPositioned } from "@/components/ui-ext/dropdown-menu"
import type { Actions } from "@/lib/actions"
import { mcpSubtitle, type SessionMeta } from "@/lib/settings"
import { saveThreadDefaults } from "@/lib/thread-defaults"
import { useStoreSelect } from "@/lib/store"
import { cn } from "@/lib/utils"

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
}: {
  meta: SessionMeta
  actions: Actions
  /** A draft can still choose; a started thread's links are already spawned. */
  editable: boolean
  className?: string
  /** False when this menu is editing a saved configuration rather than the
      draft you are about to send (a routine's kit) — see DraftScopeRow. */
  remember?: boolean
}) {
  /* Four narrow reads, not the state: this menu is in the composer row of a
     live transcript. Each library is replaced only by its own action. */
  const profile = useStoreSelect((state) => state.profiles.find((p) => p.id === meta.profileId))
  const mcpServers = useStoreSelect((state) => state.mcpServers)
  const skills = useStoreSelect((state) => state.skills)
  const commands = useStoreSelect((state) => state.commands)
  const inherited: Record<LinkKey, Set<string>> = {
    mcpServerIds: new Set(profile?.mcpServerIds ?? []),
    skillIds: new Set(profile?.skillIds ?? []),
    commandIds: new Set(profile?.commandIds ?? []),
  }
  const own: Record<LinkKey, string[]> = {
    mcpServerIds: meta.mcpServerIds ?? [],
    skillIds: meta.skillIds ?? [],
    commandIds: meta.commandIds ?? [],
  }
  const toggle = (key: LinkKey, id: string, on: boolean) => {
    const next = on ? [...own[key].filter((x) => x !== id), id] : own[key].filter((x) => x !== id)
    actions.configureDraft(meta.id, { [key]: next })
    // Remembered like the agent is: a reload rebuilds the draft from these,
    // and the next thread starts with the same kit. Unless this menu is not
    // about the next thread at all — see `remember`.
    if (remember) saveThreadDefaults({ ...own, [key]: next })
  }
  const extra = own.mcpServerIds.length + own.skillIds.length + own.commandIds.length
  const total =
    extra + inherited.mcpServerIds.size + inherited.skillIds.size + inherited.commandIds.size

  const section = <T extends { id: string; name: string }>(
    title: string,
    icon: React.ReactNode,
    key: LinkKey,
    items: T[],
    hint: (item: T) => string
  ) => {
    /* A draft offers the whole library to pick from; a started thread lists
       only what it is actually running — the rest is neither a choice it has
       nor a fact about it. */
    const shown = editable
      ? items
      : items.filter((item) => inherited[key].has(item.id) || own[key].includes(item.id))
    if (!editable && shown.length === 0) return null
    const on = shown.filter(
      (item) => inherited[key].has(item.id) || own[key].includes(item.id)
    ).length
    return (
      <DropdownMenuSub key={key}>
        <DropdownMenuSubTrigger className="gap-2.5">
          {icon}
          <span className="truncate">{title}</span>
          {/* The count is the point of the row: it is what the flat menu made
              you open a group to learn. "2 of 9" while picking, a bare figure
              once the thread has spawned and the library is no longer a
              choice. */}
          <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
            {editable ? (on === 0 ? `${shown.length}` : `${on} of ${shown.length}`) : on}
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64">
          {shown.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs">
              None in the library.
            </DropdownMenuItem>
          ) : (
            shown.map((item) => {
              const from = inherited[key].has(item.id)
              return (
                <DropdownMenuCheckboxItem
                  key={item.id}
                  checked={from || own[key].includes(item.id)}
                  disabled={from || !editable}
                  closeOnClick={false}
                  onCheckedChange={(checked) => editable && toggle(key, item.id, checked === true)}
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
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    )
  }

  // Nothing to read out, so nothing on the composer row.
  if (!editable && total === 0) return null

  const iconClass = "size-4 text-muted-foreground"
  const sections = [
    section("MCP servers", <ServerIcon className={iconClass} />, "mcpServerIds", mcpServers, mcpSubtitle),
    section("Skills", <BlocksIcon className={iconClass} />, "skillIds", skills, (s) => s.path),
    section(
      "Slash commands",
      <SlashSquareIcon className={iconClass} />,
      "commandIds",
      commands,
      (c) => `/${c.name}`
    ),
  ].filter(Boolean)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            title={editable ? "Tools for this thread" : "Tools this thread is running with"}
            className={cn(
              "h-6 min-w-0 gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-[11px] font-normal text-muted-foreground shadow-none hover:bg-accent/50 hover:text-foreground data-popup-open:bg-accent/50",
              className
            )}
          >
            <WrenchIcon className="size-3.5" />
            <span className="max-w-40 truncate">
              {total === 0 ? "No tools" : `${total} tool${total === 1 ? "" : "s"}`}
              {editable && extra > 0 && ` (+${extra})`}
            </span>
          </Button>
        }
      />
      {/* On the draft strip: pinned below rather than flipping above it — the
          popup already sizes itself to the room it has and scrolls, so keeping
          the side fixed costs nothing and keeps the three menus on the strip
          opening the same way. On a started thread the trigger sits in the
          composer's own control row, at the bottom of the panel, where a menu
          pinned below would open off screen — so that one opens upwards like
          every other control beside it. */}
      <DropdownMenuContentPositioned
        align="start"
        side={editable ? "bottom" : "top"}
        collisionAvoidance={
          editable ? { side: "none", fallbackAxisSide: "none" } : undefined
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
          {sections}
        </DropdownMenuGroup>
        {/* Only offered when there is something of the thread's own to take
            back: the profile's links are not this menu's to clear. */}
        {editable && extra > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                const cleared = { mcpServerIds: [], skillIds: [], commandIds: [] }
                actions.configureDraft(meta.id, cleared)
                if (remember) saveThreadDefaults(cleared)
              }}
            >
              Clear this thread&rsquo;s picks
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContentPositioned>
    </DropdownMenu>
  )
}
