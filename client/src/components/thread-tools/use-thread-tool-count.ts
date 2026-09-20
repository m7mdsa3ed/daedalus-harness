/**
 * How many tools a thread is carrying - its own picks.
 * Profiles carry no links; a profile is provider credentials.
 */
import { type SessionMeta } from "@/lib/settings"

/** See the menu for why this count lives here and not there. */
export function useThreadToolCount(meta: SessionMeta): number {
  return (
    (meta.mcpServerIds?.length ?? 0) +
    (meta.skillIds?.length ?? 0) +
    (meta.commandIds?.length ?? 0)
  )
}
