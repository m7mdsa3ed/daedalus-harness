/* The project overview's server half. Mirrors `server/src/project-stats.ts`,
   one call for the whole page: the browser already knows the project's *live*
   state (its threads, and which of them are running, are in `state.sessions`),
   so this is only what the database can answer — turns taken, when the last
   one was, what the workspace has accumulated. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export interface ProjectStats {
  projectId: string
  /** The working directory still exists on the server. False is the one health
      answer the overview can give: every thread started here would fail. */
  cwdExists: boolean
  threads: {
    total: number
    trashed: number
    /** Workflow steps — real threads, hidden from the lists. */
    steps: number
    firstAt: number | null
    newestAt: number | null
  }
  /** Journaled turns across every thread of the project, steps included. */
  turns: number
  /** Newest journaled event, or null for a project nothing has run in. */
  lastActivityAt: number | null
  /** Turns per local day, oldest first; days with none are absent. */
  activity: { day: string; turns: number }[]
  byAgent: { id: string; threads: number }[]
  byProfile: { id: string; threads: number }[]
  knowledge: number
  previews: number
  webSearch: { searches: number; fetches: number }
  scheduled: { total: number; enabled: number }
  workflows: { total: number; running: number; failed: number }
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

export function fetchProjectStats(projectId: string, signal?: AbortSignal): Promise<ProjectStats> {
  return api<ProjectStats>(server(), `/api/projects/${encodeURIComponent(projectId)}/stats`, {
    signal,
  })
}

/** The activity strip as a fixed run of days ending today — the server sends
    only the days that had turns, and a bar chart with the empty days missing
    would compress a quiet fortnight into nothing and read as busy. */
export function activityDays(
  activity: ProjectStats["activity"],
  days: number,
  now = Date.now()
): { day: string; turns: number }[] {
  const counts = new Map(activity.map((entry) => [entry.day, entry.turns]))
  const out: { day: string; turns: number }[] = []
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (days - 1))
  for (let i = 0; i < days; i++) {
    // The server buckets in *local* time (see project-stats.ts), so the key is
    // built from local parts here too rather than through toISOString().
    const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
      cursor.getDate()
    ).padStart(2, "0")}`
    out.push({ day, turns: counts.get(day) ?? 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}
