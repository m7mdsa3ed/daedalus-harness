import { McpIcon } from "@/components/entity-icon"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { formatCount } from "@/components/composer-strip"
import { useMcpServers } from "@/lib/queries/catalog"
import { useStoreSelect } from "@/lib/store"
import type { McpServerDef, SessionMeta } from "@/lib/settings"

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
          className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-full bg-background ring-1 ring-composer"
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
 * The MCP servers this thread will carry, as a reading beside the model picker:
 * the avatar group, and the name where exactly one is selected and there is
 * room. Read-only — picking is the model menu's Tools section — and a started
 * thread's staged links outrank its row, the layering that menu reads. Draws
 * nothing when none is selected.
 */
export function McpSelected({ meta }: { meta: SessionMeta }) {
  const library = useMcpServers()
  const staged = useStoreSelect((state) => state.threads[meta.id]?.stagedConfig?.mcpServerIds)
  const ids = staged ?? meta.mcpServerIds ?? []
  const servers = ids.flatMap((id) => library.find((server) => server.id === id) ?? [])
  if (servers.length === 0) return null
  return (
    <span
      className="flex h-5 min-w-0 shrink-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground pointer-coarse:h-7"
      aria-label="Selected MCP servers"
      title={servers.map((server) => server.name).join(", ")}
    >
      <McpAvatars servers={servers} />
      {servers.length === 1 && (
        <span className="hidden max-w-28 truncate @panel-sm:inline">{servers[0].name}</span>
      )}
    </span>
  )
}
