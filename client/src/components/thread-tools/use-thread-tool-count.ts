/**
 * How many tools a thread is carrying — its own picks plus its profile's.
 * The one place that figure is spelled; see the export's comment for why it is
 * not the menu's private business.
 */
import { type SessionMeta } from "@/lib/settings"
import { useProfiles } from "@/lib/queries/catalog"

/**
 * How many tools this thread is carrying, the thread's own picks plus the
 * profile's.
 *
 * Exported because it is also the rule that decides whether the menu draws at
 * all (`total === 0` on a started thread renders nothing), and the row the menu
 * sits in has to know that before it draws a divider in front of it — a
 * separator hanging off nothing is what "the menu decides for itself" costs
 * every caller. One place spells the count.
 */
export function useThreadToolCount(meta: SessionMeta): number {
  const profile = useProfiles().find((p) => p.id === meta.profileId)
  return (
    (meta.mcpServerIds?.length ?? 0) +
    (meta.skillIds?.length ?? 0) +
    (meta.commandIds?.length ?? 0) +
    new Set(profile?.mcpServerIds ?? []).size +
    new Set(profile?.skillIds ?? []).size +
    new Set(profile?.commandIds ?? []).size
  )
}
