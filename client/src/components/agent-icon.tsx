import { BotIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/* Real brand marks for the built-in agents, supplied by the user. PNG data
   URIs mean the component has no asset-pipeline dependency and every
   consumer — desktop picker, mobile picker, settings — gets the same art.
   Unknown agent ids fall through to a neutral glyph. */
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

/** Real brand marks for built-in agents, with a neutral glyph for any
    server-defined agent the client does not know yet. */
export function AgentIcon({ agentId, className }: { agentId?: string; className?: string }) {
  const entry = agentId ? AGENT_ICONS[agentId] : undefined
  if (entry) {
    return <img src={entry.src} alt="" aria-hidden="true" className={cn("shrink-0 rounded-full bg-muted ring-1 ring-border/40", className)} />
  }
  return <BotIcon aria-hidden="true" className={cn("shrink-0 text-muted-foreground", className)} />
}
