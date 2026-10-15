/* ── The right panel ──
   The one column beside the centre pane that holds the tools about what is in
   front of you: a thread's readings (changes, plan, agents, details, tokens,
   trajectory), its shells and its preview. It replaces the thread dock — a
   nested dockview per chat tab — with one panel and a rail of sections.

   **Two kinds of state, split by what they belong to.** Whether the panel is
   open, and how wide, are the *device's*: opening it in one thread opens it in
   the next, like the inspector it grew out of. Which section is in front, the
   shells and the preview are the *scope's* — a thread's, or a project page's —
   because a shell rooted in one thread's worktree means nothing beside
   another's.

   The mobile sheet's open flag is deliberately not here: a restored overlay
   covering every screen on a phone looks like a bug, so it lives in a bare
   cell (`rightSheet`) that is never persisted.

   Everything is a plain function, not a hook, so the palette, the shortcuts and
   the helpers that run outside React can open a section too. */
import { createLocalStore, createStore } from "@/lib/local-store"
import type { WebDiff } from "@/lib/workspace/panels"

export type RightSection =
  | "changes"
  | "plan"
  | "agents"
  | "details"
  | "tokens"
  | "trajectory"
  | "terminal"
  | "preview"

/** Every section a thread scope offers, in rail order. */
export const THREAD_SECTIONS: readonly RightSection[] = [
  "changes",
  "plan",
  "agents",
  "details",
  "tokens",
  "trajectory",
  "terminal",
  "preview",
]
/** A project page (or the landing page) has no thread, so no readings. */
export const PAGE_SECTIONS: readonly RightSection[] = ["terminal", "preview"]

export const RIGHT_MIN = 288
export const RIGHT_DEFAULT = 380
export const RIGHT_MAX = 760

/** `t:<sessionId>`, `p:<projectId>` or `home`. */
export type Scope = string
export const HOME_SCOPE: Scope = "home"
export const threadScope = (sessionId: string): Scope => `t:${sessionId}`
export const projectScope = (projectId: string): Scope => `p:${projectId}`

export function scopeSession(scope: Scope): string | null {
  return scope.startsWith("t:") ? scope.slice(2) : null
}
export function scopeProject(scope: Scope): string | null {
  return scope.startsWith("p:") ? scope.slice(2) : null
}
export function sectionsFor(scope: Scope): readonly RightSection[] {
  return scopeSession(scope) ? THREAD_SECTIONS : PAGE_SECTIONS
}

/** A shell the panel holds. The PTY itself is the server's. */
export interface TerminalRef {
  terminalId: string
  projectId: string
  /** The thread it belongs to and its worktree, so a restart is still that thread's. */
  sessionId?: string
  cwd?: string
  /** A helper command's shell: a clean exit ends the errand and the shell goes with it. */
  closeOnExit?: boolean
}

export interface PreviewState {
  url?: string
  /** A project-relative path shown instead of the page. */
  file?: string
  /** A file against git, shown instead of the page. */
  diff?: WebDiff
}

export interface ScopeMemory {
  section: RightSection
  terminals: TerminalRef[]
  activeTerminal?: string
  preview?: PreviewState
}

interface State {
  open: boolean
  width: number
  scopes: Record<Scope, ScopeMemory>
}

const DEFAULTS: State = { open: false, width: RIGHT_DEFAULT, scopes: {} }
const SECTION_IDS = new Set<string>(THREAD_SECTIONS)
// ponytail: a write re-inserts its key, so the cap drops the scope touched
// longest ago — never swept for deleted threads, which just age out.
const KEEP = 100

function parseMemory(raw: unknown): ScopeMemory | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const section = SECTION_IDS.has(value.section as string)
    ? (value.section as RightSection)
    : "changes"
  const terminals = Array.isArray(value.terminals)
    ? value.terminals.flatMap((entry): TerminalRef[] => {
        if (!entry || typeof entry !== "object") return []
        const t = entry as Record<string, unknown>
        if (typeof t.terminalId !== "string" || typeof t.projectId !== "string") return []
        return [
          {
            terminalId: t.terminalId,
            projectId: t.projectId,
            ...(typeof t.sessionId === "string" ? { sessionId: t.sessionId } : {}),
            ...(typeof t.cwd === "string" ? { cwd: t.cwd } : {}),
            ...(t.closeOnExit === true ? { closeOnExit: true } : {}),
          },
        ]
      })
    : []
  const preview =
    value.preview && typeof value.preview === "object"
      ? (value.preview as PreviewState)
      : undefined
  return {
    section,
    terminals,
    ...(typeof value.activeTerminal === "string" ? { activeTerminal: value.activeTerminal } : {}),
    ...(preview ? { preview } : {}),
  }
}

const store = createLocalStore<State>(
  "daedalus.right-panel.v1",
  (raw) => {
    if (!raw || typeof raw !== "object") return DEFAULTS
    const stored = raw as Partial<Record<keyof State, unknown>>
    const scopes: Record<Scope, ScopeMemory> = {}
    if (stored.scopes && typeof stored.scopes === "object")
      for (const [key, value] of Object.entries(stored.scopes)) {
        const memory = parseMemory(value)
        if (memory) scopes[key] = memory
      }
    return {
      open: typeof stored.open === "boolean" ? stored.open : DEFAULTS.open,
      width:
        typeof stored.width === "number" && Number.isFinite(stored.width)
          ? Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, stored.width))
          : DEFAULTS.width,
      scopes,
    }
  },
  DEFAULTS
)

const EMPTY: ScopeMemory = Object.freeze({ section: "changes", terminals: [] as TerminalRef[] }) as ScopeMemory

function memoryOf(scope: Scope): ScopeMemory {
  const stored = store.get().scopes[scope]
  if (stored) return stored
  return scopeSession(scope) ? EMPTY : { ...EMPTY, section: "terminal" }
}

function write(scope: Scope, update: (memory: ScopeMemory) => ScopeMemory) {
  const state = store.get()
  const { [scope]: previous, ...rest } = state.scopes
  const next = update(previous ?? memoryOf(scope))
  const scopes = { ...rest, [scope]: next }
  const keys = Object.keys(scopes)
  for (const key of keys.slice(0, Math.max(0, keys.length - KEEP))) delete scopes[key]
  store.set({ ...state, scopes })
}

/* ── Reading ── */

export interface RightPanelView extends ScopeMemory {
  open: boolean
  width: number
}

/** The panel for a scope, live. `open` and `width` are the device's. */
export function useRightPanel(scope: Scope): RightPanelView {
  const state = store.use()
  const memory = state.scopes[scope] ?? memoryOf(scope)
  return { ...memory, open: state.open, width: state.width }
}

export function rightPanelOpen(): boolean {
  return store.get().open
}

/* ── Writing ── */

export function setRightOpen(open: boolean): void {
  const state = store.get()
  if (state.open !== open) store.set({ ...state, open })
}

export function toggleRightPanel(): void {
  setRightOpen(!store.get().open)
}

export function setRightWidth(width: number): void {
  const clamped = Math.round(Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, width)))
  const state = store.get()
  if (state.width !== clamped) store.set({ ...state, width: clamped })
}

/** Show a section of a scope, opening the panel (the phone's sheet too). A
    scope that does not offer the section is left alone. */
export function openSection(scope: Scope, section: RightSection, patch: Partial<ScopeMemory> = {}): void {
  if (!sectionsFor(scope).includes(section)) return
  write(scope, (memory) => ({ ...memory, ...patch, section }))
  setRightOpen(true)
  rightSheet.set(true)
}

/** Add a shell and bring it to the front. */
export function addTerminal(scope: Scope, terminal: TerminalRef): void {
  write(scope, (memory) => ({
    ...memory,
    section: "terminal",
    terminals: [...memory.terminals.filter((t) => t.terminalId !== terminal.terminalId), terminal],
    activeTerminal: terminal.terminalId,
  }))
  setRightOpen(true)
  rightSheet.set(true)
}

export function removeTerminal(scope: Scope, terminalId: string): void {
  write(scope, (memory) => {
    const terminals = memory.terminals.filter((t) => t.terminalId !== terminalId)
    return {
      ...memory,
      terminals,
      activeTerminal:
        memory.activeTerminal === terminalId ? terminals.at(-1)?.terminalId : memory.activeTerminal,
    }
  })
}

export function setActiveTerminal(scope: Scope, terminalId: string): void {
  write(scope, (memory) => ({ ...memory, activeTerminal: terminalId }))
}

export function setPreview(scope: Scope, patch: Partial<PreviewState>): void {
  write(scope, (memory) => ({ ...memory, preview: { ...memory.preview, ...patch } }))
}

export function forgetRightPanel(scope: Scope): void {
  const { [scope]: _dropped, ...scopes } = store.get().scopes
  void _dropped
  store.set({ ...store.get(), scopes })
}

/** The phone's full-screen sheet. Not persisted; see the header. */
export const rightSheet = createStore(false)

/** Forget every scope's shells and preview — a removed server's terminals are
    ids nothing can reach again. The device's open/width survive. */
export function clearRightPanelState(): void {
  store.set({ ...store.get(), scopes: {} })
}
