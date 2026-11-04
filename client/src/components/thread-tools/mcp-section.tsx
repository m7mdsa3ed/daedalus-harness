/**
 * The MCP servers a thread carries, as one submenu of the settings menu — a
 * row per server with a switch, a status dot and its transport.
 *
 * It sits beside Model and Effort because it is the same kind of thing: a spawn
 * input. A draft's picks travel with `POST /api/sessions`; a started thread's
 * are staged for the next send, exactly as a model change is. The permission
 * mode is not one of these — it goes over `session/set_mode` on the live
 * process — which is why this row lives with the pair and the mode stays under
 * "Agent options".
 *
 * It is shaped like `ToolSection` and is not one, for three things the shared
 * component has no business learning:
 *
 *   - **A server has a state a skill does not.** Connected, needs
 *     authorization, failing, not checked — read off the stored catalog, never a
 *     fresh connect, so opening the menu costs no spawn. That dot is what makes
 *     a list of servers a reading rather than a set of names.
 *   - **A row can be locked**, and the reason is a sentence: the thread's
 *     *agent* requires it — the runtime's only way to delegate is that server,
 *     so a thread without it has silently lost the capability. `requiredMcp` is
 *     the agent row's (`server/src/registry.ts`), so the client compares no ids
 *     and a fork that repoints its runtime repoints this with it.
 *   - **The library is written to**, so the submenu ends in a way out to it.
 */
import * as React from "react"
import { useNavigate } from "react-router"

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { CostMark, CostNote, MenuAddItem, MenuSearchInput, menuFilter } from "@/components/config-menu"
import type { ConfigCost } from "@/lib/config-cost"
import { McpIcon, mcpHue, mcpHueStyle } from "@/components/entity-icon"
import { useThreadToolLinks } from "@/components/thread-tools/menu"
import { ToolRow } from "@/components/thread-tools/tool-row"
import type { Actions } from "@/lib/actions"
import { useAgents, useMcpCatalog } from "@/lib/queries/catalog"
import { settingsPath } from "@/lib/router"
import { mcpNeedsAuth, mcpSubtitle, type McpServerDef, type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"

type Dot = { tone: "ok" | "warn" | "error" | "idle"; label: string; detail?: string }

/** Past this many servers the submenu grows a filter box — the same threshold
    and the same box as the model and effort rows. */
const SEARCH_THRESHOLD = 8

/** What the harness knows of a server: its stored listing (read without
    connecting) and its auth state. A built-in has no connection to speak of and
    is always available. One query per row, so the catalog is read only while a
    menu holding servers is open, and shared with the composer's own reads. */
function useServerStatus(server: McpServerDef): { status: Dot; tools: number } {
  const { data, isLoading } = useMcpCatalog(server.id, server.type !== "builtin")
  const tools = data?.ok ? data.tools.length : 0
  if (server.type === "builtin") return { status: { tone: "ok", label: "Built in" }, tools }
  if (mcpNeedsAuth(server))
    return { status: { tone: "warn", label: "Needs authorization", detail: "Settings › MCP servers" }, tools }
  if (isLoading) return { status: { tone: "idle", label: "Checking…" }, tools }
  if (data?.ok) return { status: { tone: "ok", label: "Connected" }, tools }
  if (data?.deferred) return { status: { tone: "idle", label: "Not checked yet" }, tools }
  if (data?.error) return { status: { tone: "error", label: "Error", detail: data.error }, tools }
  return { status: { tone: "idle", label: "Unknown" }, tools }
}

/** One server: its disc, name and status, a second line — the failure to act
    on, the reason it is locked, or its transport — and the tool count. */
function ServerRow({
  server,
  on,
  locked,
  lockReason,
  onToggle,
}: {
  server: McpServerDef
  on: boolean
  locked: boolean
  lockReason?: string
  onToggle: (on: boolean) => void
}) {
  const { status, tools } = useServerStatus(server)
  /* The second line is the thing to act on when there is one — a failure or a
     missing authorization — and the transport otherwise. */
  const hint =
    status.tone === "error" || status.tone === "warn"
      ? `${status.label}${status.detail ? ` — ${status.detail}` : ""}`
      : locked
        ? (lockReason ?? "from profile")
        : mcpSubtitle(server)
  return (
    <ToolRow
      name={server.name}
      icon={
        <span
          data-mcp-disc={mcpHue(server) == null ? undefined : ""}
          style={mcpHueStyle(server)}
          className={cn("grid size-6 shrink-0 place-items-center rounded-lg", mcpHue(server) == null && "bg-muted")}
        >
          <McpIcon server={server} className="size-3.5" />
        </span>
      }
      checked={on}
      disabled={locked}
      from={false}
      needsAuth={false}
      hint={tools > 0 ? `${hint} · ${tools} tool${tools === 1 ? "" : "s"}` : hint}
      dot={{ tone: status.tone, label: status.label, detail: status.detail }}
      onCheckedChange={onToggle}
    />
  )
}

/**
 * The servers this thread will carry.
 *
 * A draft's picks travel with `POST /api/sessions`; a started thread's are
 * staged by the same route the model uses, and the submenu says so — a link is
 * read by the spawn, so a change is a change waiting for one, never a live one.
 */
export function McpSection({
  meta,
  actions,
  remember = true,
  cost,
}: {
  meta: SessionMeta
  actions: Actions
  /** See `DraftScopeRow`. */
  remember?: boolean
  /** What a change costs a started thread (`lib/config-cost.ts`); none on a draft. */
  cost?: ConfigCost
}) {
  const navigate = useNavigate()
  const { mcpServers, own, set, toggle, stagedLinks } = useThreadToolLinks(meta, actions, remember)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The box is about *this* opening of the submenu, never the last one.
  React.useEffect(() => {
    if (!open) setQuery("")
  }, [open])

  const agents = useAgents()
  const threadAgent = agents.find((agent) => agent.id === meta.agentId)
  const requiredBy = (serverId: string): string | null =>
    threadAgent?.requiredMcp?.includes(serverId) ? threadAgent.name : null

  const on = (id: string) => own.mcpServerIds.includes(id)
  const selected = mcpServers.filter((server) => on(server.id) || requiredBy(server.id) !== null)
  const searchable = mcpServers.length > SEARCH_THRESHOLD
  const matching = searchable
    ? menuFilter(
        mcpServers.map((server) => ({ server, value: server.id, name: server.name, hint: mcpSubtitle(server) })),
        query
      ).map((row) => row.server)
    : mcpServers
  const groups = [
    { label: "Library", items: matching.filter((server) => server.type !== "builtin") },
    { label: "Built-in", items: matching.filter((server) => server.type === "builtin") },
  ].filter((group) => group.items.length > 0)

  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger title={cost?.text}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate">MCP servers</span>
          {/* The face the composer's chip used to wear: the servers' own discs,
              three of them, so the row is recognised before it is read. */}
          {selected.length > 0 && (
            <span aria-hidden className="flex shrink-0 items-center -space-x-1">
              {selected.slice(0, 3).map((server) => (
                <span
                  key={server.id}
                  data-mcp-disc={mcpHue(server) == null ? undefined : ""}
                  style={mcpHueStyle(server)}
                  className={cn(
                    "grid size-4 place-items-center rounded-full ring-2 ring-background",
                    mcpHue(server) == null && "bg-muted"
                  )}
                >
                  <McpIcon server={server} className="size-2.5" />
                </span>
              ))}
            </span>
          )}
        </span>
        {/* The count is the point of the row: which of a library this thread
            carries. It stays "2 of 9" on a started thread, unlike the skills
            group's bare figure — a link is still the reader's to change, it
            only lands on the next spawn, which is what the submenu says. */}
        <CostMark cost={cost} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {selected.length === 0 ? `${mcpServers.length}` : `${selected.length} of ${mcpServers.length}`}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        <CostNote cost={cost} />
        {stagedLinks?.mcpServerIds !== undefined && (
          <div className="px-3 pb-1 pt-2 text-xs text-primary">applies on next send</div>
        )}
        {searchable && <MenuSearchInput label="servers" value={query} onChange={setQuery} />}
        {mcpServers.length === 0 ? (
          <DropdownMenuItem disabled className="whitespace-normal">
            Nothing in the library yet. Add a server in Settings › MCP servers.
          </DropdownMenuItem>
        ) : groups.length === 0 ? (
          <DropdownMenuItem disabled>No match</DropdownMenuItem>
        ) : (
          groups.map((group, index) => (
            <React.Fragment key={group.label}>
              {index > 0 && <DropdownMenuSeparator />}
              {/* `index`, not `first:` — every label is its own group's first child. */}
              <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{group.label}</div>
              {group.items.map((server) => {
                const required = requiredBy(server.id)
                return (
                  <ServerRow
                    key={server.id}
                    server={server}
                    on={on(server.id) || required !== null}
                    locked={required !== null}
                    lockReason={required ? `required by ${required}` : undefined}
                    onToggle={(next) => toggle("mcpServerIds", server.id, next)}
                  />
                )
              })}
            </React.Fragment>
          ))
        )}
        {own.mcpServerIds.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem closeOnClick={false} onClick={() => set("mcpServerIds", [])}>
              Clear this thread&rsquo;s servers
            </DropdownMenuItem>
          </>
        )}
        <MenuAddItem
          add={{
            label: "Manage servers…",
            onSelect: () => {
              setOpen(false)
              void navigate(settingsPath("mcp"))
            },
          }}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
