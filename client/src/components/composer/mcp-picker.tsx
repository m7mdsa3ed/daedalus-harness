import * as React from "react"
import { KeyRoundIcon, SearchIcon, ServerIcon, SettingsIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { McpIcon } from "@/components/entity-icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { formatCount } from "@/components/composer-strip"
import { PILL, menuFilter } from "@/components/config-menu"
import { useThreadToolLinks } from "@/components/thread-tools/menu"
import { useMenuShortcut } from "@/hooks/use-hotkey"
import type { Actions } from "@/lib/actions"
import { useMcpCatalog } from "@/lib/queries/catalog"
import { settingsPath } from "@/lib/router"
import { mcpSubtitle, type McpServerDef, type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

/** How many tools a server offers, from the listing the harness already holds.
    Mounted only while the popover is open, so a closed picker reads nothing; a
    built-in has no listing and a failed one says nothing rather than "0". */
function ToolCount({ server }: { server: McpServerDef }) {
  const { data } = useMcpCatalog(server.id, server.type !== "builtin")
  if (!data?.ok || data.tools.length === 0) return null
  return (
    <span
      title={`${data.tools.length} tool${data.tools.length === 1 ? "" : "s"}`}
      className="shrink-0 rounded-pill bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums"
    >
      {formatCount(data.tools.length)}
    </span>
  )
}

/** One server: its mark, name and transport on the left, its tool count and a
    switch on the right. The row is a label, so the whole width is the target. */
function McpRow({
  server,
  on,
  locked,
  needsAuth,
  onChange,
}: {
  server: McpServerDef
  on: boolean
  locked: boolean
  needsAuth: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors has-[:focus-visible]:bg-accent",
        locked ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-accent/60",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/60">
        <McpIcon server={server} className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-4 font-medium">
          <span className="truncate">{server.name}</span>
          {/* An OAuth server nobody has connected is not advertised at spawn,
              so it is marked here and not listed as though the thread had it. */}
          {needsAuth && <KeyRoundIcon className="size-3 shrink-0 text-destructive" aria-label="needs authorization" />}
        </span>
        <span className="truncate font-mono text-[10px] leading-3 text-muted-foreground">
          {needsAuth ? "needs authorization — Settings › MCP servers" : locked ? "from profile" : mcpSubtitle(server)}
        </span>
      </span>
      <ToolCount server={server} />
      <Switch size="sm" checked={on} disabled={locked} onCheckedChange={onChange} aria-label={server.name} />
    </label>
  )
}

/**
 * The MCP servers this thread will carry, and the one place they are picked:
 * a chip beside the model pill whose face is the servers' own logos (the name
 * where exactly one is selected, a count past that, on a panel with room) and
 * whose popover is the library as a list of switches — the user's servers, then
 * the harness's built-ins — with a filter on top, and Clear and a way to
 * Settings underneath.
 *
 * Writes through `useThreadToolLinks`, so a draft's pick travels with
 * `POST /api/sessions` and a started thread's is staged for the next send — the
 * dot on the face and the note in the header say one is waiting. The model
 * menu's Tools group keeps skills and commands only.
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
  const navigate = useNavigate()
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
  const searchable = mcpServers.length > 5
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            className={cn(PILL, "relative shrink-0", selected.length > 0 && "text-foreground")}
            aria-label={`MCP servers: ${selected.length ? selected.map((s) => s.name).join(", ") : "none"}`}
            title={[
              selected.length ? selected.map((server) => server.name).join(", ") : "Pick MCP servers",
              pending && "applies on next send",
            ]
              .filter(Boolean)
              .join(" — ")}
          >
            <ServerIcon className="size-3.5" />
            {/* The count is the whole reading: a badge, no frame around the chip. */}
            {selected.length > 0 && (
              <span className="min-w-4 rounded-pill bg-primary px-1 text-center text-[10px] leading-4 font-medium text-primary-foreground tabular-nums">
                {formatCount(selected.length)}
              </span>
            )}
            {pending && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 gap-0 rounded-xl p-0" finalFocus={finalFocus}>
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
          <span className="text-[13px] font-semibold">MCP servers</span>
          <span className="rounded-pill bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums">
            {selected.length} of {mcpServers.length}
          </span>
          {pending && <span className="ml-auto text-[10px] text-primary">applies on next send</span>}
        </div>
        {searchable && (
          <div className="relative px-2 pb-2">
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-[70%] text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search servers…"
              aria-label="Search MCP servers"
              className="h-8 w-full rounded-md border bg-muted/30 pr-2 pl-8 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        )}
        <div className="max-h-[min(20rem,var(--available-height,20rem))] overflow-y-auto border-t px-1.5 py-1.5">
          {mcpServers.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              No MCP servers in the library yet. Add one in Settings › MCP servers.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No server matches “{query.trim()}”.</p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-1 last:mb-0">
                <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {group.label}
                </div>
                {group.items.map((server) => {
                  const from = inherited.mcpServerIds.has(server.id)
                  return (
                    <McpRow
                      key={server.id}
                      server={server}
                      on={isOn(server.id)}
                      locked={from}
                      needsAuth={needsAuth(server)}
                      onChange={(on) => toggle("mcpServerIds", server.id, on)}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={own.mcpServerIds.length === 0}
            onClick={() => set("mcpServerIds", [])}
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOpen(false)
              void navigate(settingsPath("mcp"))
            }}
          >
            <SettingsIcon /> Manage
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
