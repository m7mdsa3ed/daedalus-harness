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
  claudeCode: "claudeCode",
  codex: "codex",
} as const

/** One vendor's `_meta` block on an item, or null. */
export const vendorMeta = (
  meta: unknown,
  vendor: keyof typeof VENDOR_META,
): Record<string, unknown> | null => asRecord(asRecord(meta)?.[VENDOR_META[vendor]])

/** `<name>…</name>` out of an XML-ish body — task notifications and OpenCode's
    task wrapper are both read with it. */
export const tagText = (body: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return match ? match[1].trim() : null
}
