/* ── One mark for everything that has a face ──
   Agents, profiles and projects are each named beside a small picture — in
   the sidebar, the composer pickers, the settings lists, the thread card —
   and they used to be drawn three ways (a PNG disc, a white-backed logo, a
   folder glyph). `EntityIcon` is the one shape: a round mark, ringed, with
   the picture inside when there is one and a fallback when there is not or
   the URL is broken. The three exports wrap it with each entity's rule for
   where the picture comes from and what stands in:

     AgentIcon    the built-in brand marks below; a neutral bot for an id
                  the client does not know.
     ProfileIcon  the profile's own `logoUrl`; its agent's mark otherwise —
                  the virtual Default profile *is* the agent as it ships.
     ProjectIcon  the project's `logoUrl`; its initial otherwise, in a tinted
                  disc, so two projects without art still tell apart.

   The white disc under a picture is deliberate — provider marks are usually
   plain black SVGs, invisible on a dark theme without it. */
import * as React from "react"
import { BotIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/* Real brand marks for the built-in agents, supplied by the user. PNG data
   URIs mean the component has no asset-pipeline dependency and every
   consumer gets the same art. */
const CLAUDE_CODE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAHlBMVEXaakXadlXab03WXzP++PX45+LsvK7z08rfjHPloY6AmRKcAAAABHRSTlP+/v7+ukpK/AAAAP5JREFUKJG9UdluBCEMM7nz/z9cE4bdrSr1qapHXHacQAbrF+APxJIfwfcgaUG1vL6Lx5HusiSsOeMlUhMSZeQRRil9jeUESRfIO5C2h5364xSYBYRWddcwy2GPU6Q3QVYtuHUco0CIhXLmcmtjBMtujgNzH4Ks87OdHHrkcYLQsgOvSAZhnKyYEdFdbhcZJY/I0GQPHs17qSquiEmrj3Nmj5t29JWWw6cy037OFXd/rMPCR4XilZadcDahbN/M2tlG+ajZ2bpoYSk+Iv3QcxmuzMO2gg1oxoTf2+6AXdTZRCtoWul5wBhnzsXsFLkrPIZPnX9r7eU5v+0Hhf/AF8VIBuqNAYtiAAAAAElFTkSuQmCC"

const CODEX_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAAAAABXZoBIAAABEElEQVR4AbTJIWyDQACG0d+rWsxENQ6Jwi0YFLIWRTKFxecc6pIzJzF4QTKDT23lSby5BPUt6ZJe2i1ze/aJP/x/+ly5/z2PU7ne1rIYm4/tR9YDsNeaFqP3l9wFx6AJgPLylLN6rrpEcBaiQko6dR/YDq4659po55SL8D1ujI0MLGpbl/K84nr8SWbSCBj5lNrvWewQCy1wU0gZsDV+ABi603nHtI9sJ0KW9d/paCxBjwy6wawyQiwdg2VPiZeBY5S10j3XjJRNoxWMqn20DB4tKeeWTUWhDfqJsX9rSRl0gLUQe20McpCSSwWAUxdBgaek0rQ6lQEwFS/JZ1cNebWFrVaElInLlNmv0TNpYgIAMy6KDbFgKo8AAAAASUVORK5CYII="

const OPENCODE_SRC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcBAMAAACAI8KnAAAAMFBMVEUTEBAAAADi4uLZ2Nj////r6+ucm5uioaELBgazsrJCQEBOTExRT09aWFju7u7f39/EmS9sAAAAUklEQVR4AWOgEDAKgoEAlCtkDAaKUK6ICxg44uIGGxubInETBQXFkLiFDAziyNyODmTurN27VyJx59y9e5ISLm6T3////w/IJewjhPfRA4cyAAABqjJorC1X4QAAAABJRU5ErkJggg=="

const AGENT_ICONS: Record<string, { src: string; label: string }> = {
  "claude-code": { src: CLAUDE_CODE_SRC, label: "Claude Code" },
  codex: { src: CODEX_SRC, label: "Codex" },
  opencode: { src: OPENCODE_SRC, label: "OpenCode" },
}

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

/** Real brand marks for built-in agents, with a neutral glyph for any
    server-defined agent the client does not know yet. */
export function AgentIcon({ agentId, className }: { agentId?: string; className?: string }) {
  const entry = agentId ? AGENT_ICONS[agentId] : undefined
  return (
    <EntityIcon
      src={entry?.src}
      disc={false}
      className={className}
      fallback={<BotIcon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />}
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
