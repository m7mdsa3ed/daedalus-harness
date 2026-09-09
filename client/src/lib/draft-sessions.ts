/* ── Unsent threads that survive a reload ──
   A draft thread is a client-only row: the server has never heard of it, no
   agent process exists, and every list in the app filters it out (`isListed`).
   That made it invisible to the one authority that decides what a dock tab may
   keep — `prunePanels` drops a chat panel whose session the server does not
   report — so refreshing the page closed every unsent thread's tab, and the
   debounced layout save then wrote that loss to disk.

   The row is therefore persisted here, per connected server, exactly the way
   `lib/drafts.ts` persists the half-written message that belongs to it: this
   browser, not the session everyone shares. On boot the rows come back only
   for the tabs the saved dock layout still names (`bootstrap` in
   `lib/actions/core.ts`), so a draft whose tab was closed stays closed rather
   than returning as a row with nothing to draw it.

   The store is written by the three actions that can change a draft (mint,
   retune, forget) and pruned by `refreshSessions` the moment the server
   reports the id — which is exactly what sending one does. Reading is the
   untrusted path, as ever: a renamed field or a hand-edited key arrives
   looking like a thread, so every field is checked and a row that fails is
   dropped rather than trusted. */
import type { SessionMeta } from "./settings"

const PREFIX = "daedalus.draftSessions.v1"
/** Enough for any real set of open tabs; the oldest fall off the end. */
const MAX = 20

const key = (serverId: string): string => `${PREFIX}:${serverId}`

function write(serverId: string, rows: SessionMeta[]): void {
  try {
    const trimmed = [...rows].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX)
    localStorage.setItem(key(serverId), JSON.stringify(trimmed))
  } catch {
    // Quota or private-mode storage: the draft still exists in memory for this
    // page load, it just will not come back. Not worth a toast.
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined

function configChoices(value: unknown): Record<string, string | boolean> | undefined {
  if (!value || typeof value !== "object") return undefined
  const out: Record<string, string | boolean> = {}
  for (const [id, choice] of Object.entries(value as Record<string, unknown>)) {
    if (typeof choice === "string" || typeof choice === "boolean") out[id] = choice
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** One stored row → a draft, or null if it is not one. */
function parseRow(value: unknown): SessionMeta | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (row.draft !== true) return null
  const id = str(row.id)
  const profileId = str(row.profileId)
  const projectId = str(row.projectId)
  const agentId = str(row.agentId)
  const createdAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : null
  if (!id || !profileId || !projectId || !agentId || createdAt === null) return null
  const choices = configChoices(row.configChoices)
  const mcpServerIds = stringList(row.mcpServerIds)
  const skillIds = stringList(row.skillIds)
  const commandIds = stringList(row.commandIds)
  return {
    id,
    profileId,
    projectId,
    agentId,
    model: typeof row.model === "string" ? row.model : "",
    effort: typeof row.effort === "string" ? row.effort : "",
    title: str(row.title) ?? "New thread",
    createdAt,
    deletedAt: null,
    attached: false,
    exited: false,
    promptActive: false,
    cursor: 0,
    draft: true,
    ...(str(row.personaId) ? { personaId: str(row.personaId) } : {}),
    ...(typeof row.suggestFollowups === "boolean" ? { suggestFollowups: row.suggestFollowups } : {}),
    ...(str(row.modeId) ? { modeId: str(row.modeId) } : {}),
    ...(choices ? { configChoices: choices } : {}),
    ...(mcpServerIds ? { mcpServerIds } : {}),
    ...(skillIds ? { skillIds } : {}),
    ...(commandIds ? { commandIds } : {}),
  }
}

export function loadDraftSessions(serverId: string): SessionMeta[] {
  try {
    const raw = localStorage.getItem(key(serverId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((row) => {
      const draft = parseRow(row)
      return draft ? [draft] : []
    })
  } catch {
    /* Corrupt JSON reads as no drafts — the dock keeps whatever the server
       knows about, which is the same answer a first run gets. */
    return []
  }
}

/** Keep a freshly minted draft. Same id twice is one row. */
export function rememberDraft(serverId: string, row: SessionMeta): void {
  write(serverId, [row, ...loadDraftSessions(serverId).filter((draft) => draft.id !== row.id)])
}

/** Retune a stored draft. A patch function sees the row as it stands, which is
    what `chooseDraftConfigOption` needs to merge one pick into the set. */
export function patchDraft(
  serverId: string,
  id: string,
  patch: Partial<SessionMeta> | ((row: SessionMeta) => Partial<SessionMeta>)
): void {
  const rows = loadDraftSessions(serverId)
  const current = rows.find((draft) => draft.id === id)
  if (!current) return
  const next = typeof patch === "function" ? patch(current) : patch
  write(
    serverId,
    rows.map((draft) => (draft.id === id ? { ...draft, ...next } : draft))
  )
}

/** Forget one — the draft was sent, deleted, or its tab was closed. */
export function forgetDraft(serverId: string, id: string): void {
  const rows = loadDraftSessions(serverId)
  if (!rows.some((draft) => draft.id === id)) return
  write(
    serverId,
    rows.filter((draft) => draft.id !== id)
  )
}

/** Forget every draft of a server that has been removed — the sibling of
    `clearLayout`, for the same reason: the ids mean nothing on another one. */
export function clearDraftSessions(serverId: string): void {
  try {
    localStorage.removeItem(key(serverId))
  } catch {
    /* nothing to clear */
  }
}

/** Drop every stored draft the server now reports — the sweep `refreshSessions`
    runs on the same authority it prunes the other device-local stores with. */
export function pruneDraftSessions(serverId: string, known: Iterable<string>): void {
  const ids = new Set(known)
  const rows = loadDraftSessions(serverId)
  const kept = rows.filter((draft) => !ids.has(draft.id))
  if (kept.length !== rows.length) write(serverId, kept)
}
