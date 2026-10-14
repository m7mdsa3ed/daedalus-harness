import * as React from "react"
import { ServerIcon, XIcon } from "lucide-react"

import { McpIcon } from "@/components/entity-icon"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatCount } from "@/components/composer-strip"
import { MenuSearchInput, PILL, menuFilter } from "@/components/config-menu"
import { useThreadToolLinks } from "@/components/thread-tools/menu"
import { useMenuShortcut } from "@/hooks/use-hotkey"
import { ToolRow } from "@/components/thread-tools/tool-row"
import type { Actions } from "@/lib/actions"
import { mcpSubtitle, type McpServerDef, type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

/** The servers' own logos as an avatar group: up to three, overlapped and
    ringed against the composer's ground, and a `+N` chip for the rest. Each
    logo falls back to its transport mark, so a server with none is still a
    distinct glyph. One drawing for the footer reading and the scope row. */
export function McpAvatars({ servers }: { servers: McpServerDef[] }) {
  return (
    <AvatarGroup className="-space-x-1.5">
      {servers.slice(0, 3).map((server) => (
        <span
          key={server.id}
          title={server.name}
          className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/15 text-primary ring-1 ring-primary/30"
        >
          <McpIcon server={server} className="size-3.5" />
        </span>
      ))}
      {servers.length > 3 && (
        <AvatarGroupCount className="size-4 text-[9px] font-medium tabular-nums ring-1 ring-composer">
          +{formatCount(servers.length - 3)}
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  )
}

/**
 * The MCP servers this thread will carry, and the one place they are picked:
 * a chip beside the model pill whose face is the servers' own logos (the name
 * where exactly one is selected, a count past that, on a panel with room) and
 * whose menu is the library as a checklist — the user's servers, then the
 * harness's built-ins. Empty, it is a bare server mark asking to be used.
 *
 * Writes through `useThreadToolLinks`, so a draft's pick travels with
 * `POST /api/sessions` and a started thread's is staged for the next send — the
 * dot on the face says one is waiting. The model menu's Tools group keeps
 * skills and commands only.
 */
export function McpPicker({
  meta,
  actions,
  remember = true,
  keys = false,
}: {
  meta: SessionMeta
  actions: Actions
  remember?: boolean
  /** Answer `chooseMcp` — only the composer in front of you may. */
  keys?: boolean
}) {
  const { mcpServers, inherited, own, set, toggle, needsAuth, stagedLinks } = useThreadToolLinks(
    meta,
    actions,
    remember,
  )
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])
  const finalFocus = useMenuShortcut("chooseMcp", () => setOpen(!open), keys)

  const isOn = (id: string) => inherited.mcpServerIds.has(id) || own.mcpServerIds.includes(id)
  const selected = mcpServers.filter((server) => isOn(server.id))
  const pending = stagedLinks?.mcpServerIds !== undefined
  const searchable = mcpServers.length > 8
  const matching = searchable
    ? menuFilter(
        mcpServers.map((server) => ({ server, value: server.id, name: server.name, hint: mcpSubtitle(server) })),
        query,
      ).map((row) => row.server)
    : mcpServers
  const groups = [
    { label: "Library", items: matching.filter((server) => server.type !== "builtin") },
    { label: "Built-in", items: matching.filter((server) => server.type === "builtin") },
  ].filter((group) => group.items.length > 0)

  const label =
    selected.length === 0 ? "MCP" : selected.length === 1 ? selected[0].name : `${selected.length} MCPs`
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(
              PILL,
              "relative shrink-0 border transition-colors",
              selected.length > 0
                ? "border-primary/25 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary data-popup-open:bg-primary/15"
                : "border-transparent",
            )}
            aria-label={`MCP servers: ${selected.length ? selected.map((s) => s.name).join(", ") : "none"}`}
            title={[
              selected.length ? selected.map((server) => server.name).join(", ") : "Pick MCP servers",
              pending && "applies on next send",
            ]
              .filter(Boolean)
              .join(" — ")}
          >
            {selected.length > 0 ? <McpAvatars servers={selected} /> : <ServerIcon className="size-3.5" />}
            <span
              className={cn(
                "hidden max-w-28 truncate @panel-sm:inline",
                selected.length > 0 && "text-foreground/90",
              )}
            >
              {label}
            </span>
            {pending && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-72" finalFocus={finalFocus}>
        {searchable && <MenuSearchInput label="MCP servers" value={query} onChange={setQuery} />}
        {mcpServers.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuItem disabled className="whitespace-normal text-xs">
              No MCP servers in the library yet — add one in Settings › MCP servers.
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : groups.length === 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuItem disabled className="text-xs">
              No match
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : (
          groups.map((group, index) => (
            <React.Fragment key={group.label}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="flex items-center">
                  {group.label}
                  {index === 0 && (
                    <span className="ml-auto tabular-nums">
                      {pending ? "applies on next send · " : ""}
                      {selected.length} of {mcpServers.length}
                    </span>
                  )}
                </DropdownMenuLabel>
                {group.items.map((server) => {
                  const from = inherited.mcpServerIds.has(server.id)
                  return (
                    <ToolRow
                      key={server.id}
                      name={server.name}
                      icon={<McpIcon server={server} className="size-4 shrink-0" />}
                      checked={isOn(server.id)}
                      disabled={from}
                      from={from}
                      needsAuth={needsAuth(server)}
                      hint={mcpSubtitle(server)}
                      onCheckedChange={(checked) => toggle("mcpServerIds", server.id, checked)}
                    />
                  )
                })}
              </DropdownMenuGroup>
            </React.Fragment>
          ))
        )}
        {own.mcpServerIds.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => set("mcpServerIds", [])}>
              <XIcon className="size-4 text-muted-foreground" />
              Clear selection
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
