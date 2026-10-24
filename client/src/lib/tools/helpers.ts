/* Shared low-level readers for the `lib/tools/` modules. Internal: call sites
   import from the `lib/tools` barrel, never from here. */

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

/**
 * The namespaces runtimes hang their extensions off `_meta` under.
 *
 * ACP's `_meta` is the extensibility escape hatch and every adapter uses it —
 * so *reading* a vendor's block is unavoidable, and this directory is the one
 * place the codebase sanctions doing it (no component matches a vendor tool
 * name; see `docs/client.md`). What was avoidable was spelling the namespace
 * ten times: `asRecord(asRecord(item.meta)?.claudeCode)` appeared in seven
 * files, so a runtime renaming its block, or a fourth one arriving, was a
 * grep. The names live here; each reader still knows its own dialect's shape,
 * because a shape is not a name.
 */
export const VENDOR_META = {
  claudeCode: ["claudeCode"],
  codex: ["codex"],
  daedalus: ["daedalus"],
  /* JetBrains AIR's extension namespace, which both claude-agent-acp and
     codex-acp write to for a client that declares it (the harness does —
     `CLIENT_CAPABILITIES` in `server/src/acp-bridge.ts`). Nested two deep,
     hence a path rather than a key. */
  air: ["jetbrains", "air"],
} as const

/** One vendor's `_meta` block on an item, or null. */
export const vendorMeta = (
  meta: unknown,
  vendor: keyof typeof VENDOR_META,
): Record<string, unknown> | null =>
  VENDOR_META[vendor].reduce<Record<string, unknown> | null>((at, key) => asRecord(at?.[key]), asRecord(meta))

/** The id of the model request that made a call, when the runtime says
    (`_meta.daedalus.stepId`, ours). Calls with the same id were one response's
    parallel batch; a runtime that sends none is read from timing instead
    (`lib/tool-batches.ts`). */
export const stepIdOf = (meta: unknown): string | undefined =>
  str(vendorMeta(meta, "daedalus")?.stepId) ?? undefined

/** Where the wait before a model request went, said on its first call
    (`_meta.daedalus.lead`, ours): the agent's own clock for the causes it
    booked, the time to the model's first output and how long it wrote before
    the call opened. Absent for a runtime that does not meter, and for a call
    that was not its request's first. */
export interface StepLead {
  ttftMs?: number
  writeMs?: number
  heldMs?: number
  compactMs?: number
  retryMs?: number
}
const LEAD_KEYS = ["ttftMs", "writeMs", "heldMs", "compactMs", "retryMs"] as const
export const stepLeadOf = (meta: unknown): StepLead | undefined => {
  const raw = vendorMeta(meta, "daedalus")?.lead
  if (!raw || typeof raw !== "object") return undefined
  const lead: StepLead = {}
  for (const key of LEAD_KEYS) {
    const ms = (raw as Record<string, unknown>)[key]
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) lead[key] = ms
  }
  return Object.keys(lead).length > 0 ? lead : undefined
}

/** `<name>…</name>` out of an XML-ish body — task notifications and OpenCode's
    task wrapper are both read with it. */
export const tagText = (body: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return match ? match[1].trim() : null
}
