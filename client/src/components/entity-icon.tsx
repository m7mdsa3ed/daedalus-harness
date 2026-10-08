/* ── One mark for everything that has a face ──
   Agents, profiles and projects are each named beside a small picture — in
   the sidebar, the composer pickers, the settings lists, the thread card —
   and they used to be drawn three ways (a PNG disc, a white-backed logo, a
   folder glyph). `EntityIcon` is the one shape: a round mark, ringed, with
   the picture inside when there is one and a fallback when there is not or
   the URL is broken. The three exports wrap it with each entity's rule for
   where the picture comes from and what stands in:

     AgentIcon    the mark the *server* puts on the row (`AgentDef.icon`): a
                  URL, or `"app"` for the harness's own runtime, whose mark is
                  the app's; a neutral bot for a row carrying neither.
     ProfileIcon  the profile's own `logoUrl`; its agent's mark otherwise —
                  the virtual Default profile *is* the agent as it ships.
     ProjectIcon  the project's `logoUrl`; its initial otherwise, in a tinted
                  disc, so two projects without art still tell apart.

   The white disc under a picture is deliberate — provider marks are usually
   plain black SVGs, invisible on a dark theme without it. */
import * as React from "react"
import {
  AppWindowIcon,
  BookOpenIcon,
  BotIcon,
  GlobeIcon,
  TerminalIcon,
  UsersIcon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react"
import { Logo } from "@/components/ui/logo"
import { useAgents, useMcpCatalog } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"
import type { McpServerDef } from "@/lib/settings"

/** `AgentDef.icon` for the harness's own runtime: its mark is the app's, drawn
    in currentColor so it themes with everything else rather than being a
    fourth piece of flat art. The one value that is not a URL. */
const APP_MARK = "app"

/** The base mark. `src` when it loads, `fallback` otherwise — a broken URL
    is remembered per src so it falls back once and stays there. Size comes
    from the caller's `className` (`size-4` is the row size everywhere). */
export function EntityIcon({
  src,
  fallback,
  className,
  disc = true,
}: {
  src?: string | null
  fallback: React.ReactNode
  className?: string
  /** Paint the white disc under the picture. Off for art that carries its
      own background (the built-in agent PNGs). */
  disc?: boolean
}) {
  const url = src?.trim() || null
  const [brokenSrc, setBrokenSrc] = React.useState<string | null>(null)
  if (!url || url === brokenSrc) return <>{fallback}</>
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      onError={() => setBrokenSrc(url)}
      className={cn(
        "shrink-0 rounded-full object-contain ring-1 ring-border/40",
        disc ? "bg-white p-px" : "bg-muted",
        className
      )}
    />
  )
}

/** The mark on the agent's row, with a neutral glyph for a row that carries
    none.

    The art used to be a table in this file keyed by three agent ids, which
    meant an agent someone added could never have a face and the client held an
    opinion about which runtimes exist. It is the row's now (`AgentDef.icon`,
    seeded per built-in and editable in Settings › Agents), read from the
    agents query — already cached for the page, so this costs no request.

    `"app"` is the one value that is not a URL: the harness's own runtime draws
    the real `Logo` in currentColor. The neutral bot stays the answer for a row
    with nothing — wearing our mark is a claim, not a placeholder. */
export function AgentIcon({ agentId, className }: { agentId?: string; className?: string }) {
  const agents = useAgents()
  const icon = agentId ? agents.find((a) => a.id === agentId)?.icon : null
  return (
    <EntityIcon
      src={icon && icon !== APP_MARK ? icon : undefined}
      disc={false}
      className={className}
      fallback={
        icon === APP_MARK ? (
          <Logo className={cn("shrink-0 rounded-full text-primary", className)} />
        ) : (
          <BotIcon aria-hidden="true" className={cn("shrink-0 rounded-full text-muted-foreground", className)} />
        )
      }
    />
  )
}

/** The profile's own logo when it has one, the agent's brand mark otherwise.
    A gateway profile is a provider, and its logo is its identity — drawing
    the agent's mark beside it read as two things where there is one. */
export function ProfileIcon({
  profile,
  agentId,
  className,
}: {
  profile?: { logoUrl?: string; agents?: Record<string, unknown> } | null
  /** Which of the profile's agents this is about. A profile may serve several,
      so callers that know (a thread, a draft) say; a profile listing that does
      not falls back to the profile's first. */
  agentId?: string
  className?: string
}) {
  return (
    <EntityIcon
      src={profile?.logoUrl}
      className={className}
      fallback={
        <AgentIcon agentId={agentId ?? Object.keys(profile?.agents ?? {})[0]} className={className} />
      }
    />
  )
}

/** A model's logo when it has one; a neutral glyph otherwise, so rows with
    and without art stay aligned. */
const BUILTIN_MCP_MARKS = {
  "web-search": GlobeIcon,
  knowledge: BookOpenIcon,
  workflow: WorkflowIcon,
  agents: UsersIcon,
  harness: WrenchIcon,
  browser: AppWindowIcon,
} as const

/** A server's own image when supplied, otherwise the one the harness fetched
    for it (`mcp-logo.ts`, inline in the listing — the browser asks nobody);
    transport and built-in marks remain the fallback. */
export function McpIcon({ server, className }: { server?: McpServerDef | null; className?: string }) {
  /* Three sources, in the order they are trusted: what the row says, what the
     server said about itself when it was last read (the initialize answer's
     `icons`, remembered in the shared catalog query — never a connect of its
     own), and nothing else: the favicon is fetched by the server now. */
  const catalog = useMcpCatalog(server?.id ?? "", !!server && server.type !== "builtin").data
  const Icon = server?.type === "builtin"
    ? BUILTIN_MCP_MARKS[server.builtin]
    : server?.type === "http"
      ? GlobeIcon
      : TerminalIcon
  return (
    <EntityIcon
      src={server?.type === "builtin" ? undefined : server?.logoUrl || catalog?.serverInfo?.icon}
      className={className}
      fallback={<Icon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />}
    />
  )
}

export function ModelIcon({
  iconUrl,
  className,
}: {
  iconUrl?: string | null
  className?: string
}) {
  return (
    <EntityIcon
      src={iconUrl}
      className={className}
      fallback={<BotIcon aria-hidden="true" className={cn("shrink-0 rounded-full text-muted-foreground", className)} />}
    />
  )
}

/** The project's logo when it has one; its initial otherwise. */
export function ProjectIcon({
  project,
  className,
}: {
  project?: { name: string; logoUrl?: string | null } | null
  className?: string
}) {
  return (
    <EntityIcon
      src={project?.logoUrl}
      className={className}
      fallback={<InitialMark name={project?.name ?? ""} className={className} />}
    />
  )
}

/** A letter in a tinted disc. The hue comes from the name, so the same
    project is the same colour on every device and every screen. */
function InitialMark({ name, className }: { name: string; className?: string }) {
  const letter = name.trim().charAt(0).toUpperCase() || "?"
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return (
    <span
      aria-hidden="true"
      style={{
        backgroundColor: `oklch(0.92 0.06 ${hue})`,
        color: `oklch(0.38 0.12 ${hue})`,
      }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold leading-none ring-1 ring-border/40 [font-size:0.55em]",
        className
      )}
    >
      {letter}
    </span>
  )
}
