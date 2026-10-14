/* The tools a thread carries, as rows of the mobile settings drawer
   (`ConfigDrawer`): one drill-down row per kind, its page a list of switches.
   Reads the same links `ThreadToolsSections` does (`useThreadToolLinks`), so
   what a switch writes is what a menu toggle writes — a draft's pick, or a
   started thread's change staged for the next send. MCP servers are the
   composer chip's (`composer/mcp-avatars.tsx`), not a drawer page. */
import { KeyRoundIcon, BlocksIcon, SlashSquareIcon } from "lucide-react"
import type { ReactNode } from "react"

import type { DrawerRow } from "@/components/config-drawer"
import { Switch } from "@/components/ui/switch"
import type { Actions } from "@/lib/actions"
import type { SessionMeta } from "@/lib/settings"
import { useThreadToolLinks } from "./menu"

function SwitchList<T extends { id: string; name: string }>({
  items,
  icon,
  hint,
  on,
  locked,
  needsAuth,
  onToggle,
}: {
  items: T[]
  icon?: (item: T) => ReactNode
  hint: (item: T) => string
  on: (item: T) => boolean
  locked: (item: T) => boolean
  needsAuth: (item: T) => boolean
  onToggle: (item: T, on: boolean) => void
}) {
  if (items.length === 0) return <p className="px-2 py-3 text-xs text-muted-foreground">None in the library.</p>
  return (
    <>
      {items.map((item) => (
        <label key={item.id} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5">
          {icon?.(item)}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5 text-sm">
              <span className="truncate">{item.name}</span>
              {needsAuth(item) && <KeyRoundIcon className="size-3 shrink-0 text-destructive" aria-label="needs authorization" />}
            </span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {needsAuth(item) ? "needs authorization — Settings › MCP servers" : hint(item)}
            </span>
          </span>
          <Switch checked={on(item)} disabled={locked(item)} onCheckedChange={(v) => onToggle(item, v)} aria-label={item.name} />
        </label>
      ))}
    </>
  )
}

/** Hook, so the parent can call it unconditionally ahead of any early return. */
export function useToolDrawerRows(meta: SessionMeta, actions: Actions, remember = true): DrawerRow[] {
  const { mcpServers, skills, commands, inherited, own, toggle, needsAuth } = useThreadToolLinks(meta, actions, remember)
  const iconClass = "size-4 text-muted-foreground"
  const count = (key: "mcpServerIds" | "skillIds" | "commandIds", total: number) => {
    const n = new Set([...inherited[key], ...own[key]]).size
    return n === 0 ? `${total}` : `${n} of ${total}`
  }
  const list = <T extends { id: string; name: string }>(
    key: "mcpServerIds" | "skillIds" | "commandIds",
    items: T[],
    hint: (item: T) => string,
    icon?: (item: T) => ReactNode
  ) => (
    <SwitchList
      items={items}
      icon={icon}
      hint={hint}
      on={(item) => inherited[key].has(item.id) || own[key].includes(item.id)}
      locked={(item) => inherited[key].has(item.id)}
      needsAuth={(item) => needsAuth(item)}
      onToggle={(item, on) => toggle(key, item.id, on)}
    />
  )
  return [
    { type: "label", text: "Tools" },
    {
      type: "page",
      label: "Skills",
      icon: <BlocksIcon className={iconClass} />,
      value: count("skillIds", skills.length),
      content: list("skillIds", skills, (s) => s.path),
    },
    {
      type: "page",
      label: "Slash commands",
      icon: <SlashSquareIcon className={iconClass} />,
      value: count("commandIds", commands.length),
      content: list("commandIds", commands, (c) => `/${c.name}`),
    },
  ]
}
