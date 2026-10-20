import * as React from "react"
import { SearchIcon, ServerIcon, SettingsIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { McpIcon } from "@/components/entity-icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { ChipBadge, formatCount } from "@/components/composer-strip"
import { Badge } from "@/components/ui/badge"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { PILL, menuFilter } from "@/components/config-menu"
import { READING_MARK } from "@/components/composer/indicator"
import { useThreadToolLinks } from "@/components/thread-tools/menu"
import { useMenuShortcut } from "@/hooks/use-hotkey"
import type { Actions } from "@/lib/actions"
import { useMcpCatalog } from "@/lib/queries/catalog"
import { settingsPath } from "@/lib/router"
import { mcpSubtitle, type McpServerDef, type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

type Status = { tone: "ok" | "warn" | "error" | "idle"; label: string; detail?: string }

const DOT: Record<Status["tone"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  idle: "bg-muted-foreground/40",
}

/** What the harness knows of a server, from its stored listing (read without
    connecting) and its auth state: connected, needs authorization, failed, or
    not checked yet. A built-in has no connection to speak of and is always
    available. Mounted only while the popover is open. */
function useServerStatus(server: McpServerDef, needsAuth: boolean): { status: Status; tools: number } {
  const { data, isLoading } = useMcpCatalog(server.id, server.type !== "builtin")
  const tools = data?.ok ? data.tools.length : 0
  if (server.type === "builtin") return { status: { tone: "ok", label: "Built in" }, tools }
  if (needsAuth) return { status: { tone: "warn", label: "Needs authorization", detail: "Settings › MCP servers" }, tools }
  if (isLoading) return { status: { tone: "idle", label: "Checking…" }, tools }
  if (data?.ok) return { status: { tone: "ok", label: "Connected" }, tools }
  if (data?.deferred) return { status: { tone: "idle", label: "Not checked yet" }, tools }
  if (data?.error) return { status: { tone: "error", label: "Error", detail: data.error }, tools }
  return { status: { tone: "idle", label: "Unknown" }, tools }
}

/** One server: its mark, name, status dot and transport on the left, its tool
    count and a switch on the right. The row is a label, so the whole width is
    the target. */
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
  const { status, tools } = useServerStatus(server, needsAuth)
  /* The second line is the thing to act on when there is one — a failure or a
     missing authorization — and the transport otherwise. */
  const second =
    status.tone === "error" || status.tone === "warn"
      ? `${status.label}${status.detail ? ` — ${status.detail}` : ""}`
      : locked
        ? "from profile"
        : mcpSubtitle(server)
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 rounded-xl p-1 transition-colors has-[:focus-visible]:bg-muted",
        locked ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-muted",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted">
        <McpIcon server={server} className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{server.name}</span>
          {/* An OAuth server nobody has connected is not advertised at spawn, so
              it is marked here rather than listed as though the thread had it. */}
          <span
            role="img"
            aria-label={status.label}
            title={status.detail ? `${status.label} — ${status.detail}` : status.label}
            className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])}
          />
        </span>
        <span
          className={cn(
            "truncate font-mono text-xs",
            status.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          title={second}
        >
          {second}
        </span>
      </span>
      {tools > 0 && (
        <Badge variant="secondary" title={`${tools} tool${tools === 1 ? "" : "s"}`} className="tabular-nums">
          {formatCount(tools)}
        </Badge>
      )}
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
            <ServerIcon className={READING_MARK} />
            {/* The count is the whole reading: a badge, no frame around the chip. */}
            {selected.length > 0 && (
              <ChipBadge>{formatCount(selected.length)}</ChipBadge>
            )}
            {pending && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 gap-0 p-0" finalFocus={finalFocus}>
        <div className="flex items-center gap-2 border-b px-2 py-2">
          <span className="text-sm font-medium">MCP servers</span>
          <Badge variant="secondary" className="tabular-nums">
            {selected.length} of {mcpServers.length}
          </Badge>
          {pending && <span className="ml-auto text-xs text-primary">applies on next send</span>}
        </div>
        {searchable && (
          <div className="px-2 pt-2">
            <InputGroup className="h-8">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search servers…"
                aria-label="Search MCP servers"
              />
            </InputGroup>
          </div>
        )}
        <div className="max-h-[min(20rem,var(--available-height,20rem))] overflow-y-auto p-1">
          {mcpServers.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No MCP servers in the library yet. Add one in Settings › MCP servers.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">No server matches “{query.trim()}”.</p>
          ) : (
            groups.map((group, index) => (
              <div key={group.label}>
                {/* `index`, not `first:`: every label is its own group's first child. */}
                <div className={cn("px-1 pb-1 text-xs font-medium text-muted-foreground", index === 0 ? "pt-1" : "pt-2")}>
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
        <div className="flex items-center justify-between gap-2 border-t p-1">
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
            <SettingsIcon data-icon="inline-start" /> Manage
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
