/**
 * The tools menu itself: the trigger that states the count, and the popup that
 * holds the three submenus. It owns everything that is about *the thread* —
 * which links are the profile's, which are its own, what a toggle writes, and
 * whether the runtime will read them at all — and hands each submenu only the
 * slice it draws.
 */
import * as React from "react"
import { ChevronRightIcon, KeyRoundIcon, WrenchIcon } from "lucide-react"

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
import { Switch } from "@/components/ui/switch"
import type { SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

import { ToolSection } from "./tool-section"
import { rowSubtitle, sectionView, unreadableNote, useThreadTools } from "./use-thread-tools"

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
 * toolset. What the thread carries and what a pick writes are `useThreadTools`'s,
 * shared with `ThreadToolsPanel` below.
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
  const { sections, extra, total, needsAuth, agentName, clear } = useThreadTools(
    meta,
    actions,
    remember
  )

  // Nothing to read out, so nothing on the composer row.
  if (!editable && total === 0) return null

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
  const common = { editable, needsAuth, agentName }

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
          {sections.map((section) => (
            <ToolSection key={section.title} {...common} section={section} />
          ))}
        </DropdownMenuGroup>
        {/* Only offered when there is something of the thread's own to take
            back: the profile's links are not this menu's to clear. */}
        {editable && extra > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={clear}>
              Clear this thread&rsquo;s picks
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContentPositioned>
    </DropdownMenu>
  )
}

/**
 * The same thread's tools, drawn in flow instead of behind a trigger — for a
 * surface that is already the opened thing (the panel that expands under the
 * composer strip), where a popup inside a popup is one layer too many.
 *
 * Everything it knows is `useThreadTools`'s and `sectionView`'s, exactly as the
 * menu's is: the same sections, the same counts, the same locked profile rows,
 * the same read-out on a started thread, the same writes. Only the drawing
 * differs — a kind is a row with a chevron that opens its list underneath,
 * where the menu opened a submenu beside it. Nothing is open to begin with,
 * for the menu's reason: a library grows, and the count on each row is what
 * the reader came for.
 */
export function ThreadToolsPanel({
  meta,
  actions,
  editable,
  remember = true,
}: {
  meta: SessionMeta
  actions: Actions
  /** A draft can still choose; a started thread's links are already spawned. */
  editable: boolean
  /** False when editing a saved configuration rather than the draft about to
      be sent — see `ThreadToolsMenu`. */
  remember?: boolean
}) {
  const { sections, extra, total, needsAuth, agentName, clear } = useThreadTools(
    meta,
    actions,
    remember
  )
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set())
  const flip = (title: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(title)) next.add(title)
      return next
    })

  // The menu draws nothing here either: a read-out of nothing is not a reading.
  if (!editable && total === 0) return null

  const ROW = "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-xs hover:bg-muted"
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {editable ? "Tools for this thread" : "Running with"}
      </div>
      {sections.map((section) => {
        const view = sectionView(section, editable)
        if (!view) return null
        const expanded = open.has(section.title)
        return (
          <div key={section.title} className="flex flex-col">
            <button
              type="button"
              className={ROW}
              aria-expanded={expanded}
              onClick={() => flip(section.title)}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-90"
                )}
              />
              {section.icon}
              <span className="truncate">{section.title}</span>
              <span className="ml-auto pl-2 tabular-nums text-muted-foreground">{view.count}</span>
            </button>
            {expanded && (
              <div className="flex flex-col gap-0.5 pl-6">
                {section.unreadable && (
                  <div className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                    {unreadableNote(agentName, section.unreadable)}
                  </div>
                )}
                {view.shown.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    None in the library.
                  </div>
                ) : (
                  view.shown.map((item) => {
                    const from = section.inherited.has(item.id)
                    const auth = needsAuth(item)
                    const checked = view.has(item.id)
                    const disabled = from || !editable
                    return (
                      /* The whole row is the target, as a menu item was; the
                         switch says the state and takes its own click, which
                         is why it stops here rather than toggling twice. */
                      <div
                        key={item.id}
                        className={cn(ROW, "h-auto min-h-8 py-1", disabled ? "cursor-default" : "cursor-pointer")}
                        onClick={() => !disabled && section.onToggle(item.id, !checked)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{item.name}</span>
                            {auth && (
                              <KeyRoundIcon
                                className="size-3 shrink-0 text-destructive"
                                aria-label="needs authorization"
                              />
                            )}
                          </span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {rowSubtitle(auth, from, section.hint(item))}
                          </span>
                        </span>
                        <span onClick={(e) => e.stopPropagation()} className="flex">
                          <Switch
                            size="sm"
                            checked={checked}
                            disabled={disabled}
                            aria-label={item.name}
                            onCheckedChange={(on) => section.onToggle(item.id, on)}
                          />
                        </span>
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )
      })}
      {/* Only offered when there is something of the thread's own to take
          back: the profile's links are not this panel's to clear. */}
      {editable && extra > 0 && (
        <button type="button" className={cn(ROW, "mt-1 text-muted-foreground")} onClick={clear}>
          Clear this thread&rsquo;s picks
        </button>
      )}
    </div>
  )
}
