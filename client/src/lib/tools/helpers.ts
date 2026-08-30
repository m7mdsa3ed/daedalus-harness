/* Shared low-level readers for the `lib/tools/` modules. Internal: call sites
   import from the `lib/tools` barrel, never from here. */

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

/** `<name>…</name>` out of an XML-ish body — task notifications and OpenCode's
    task wrapper are both read with it. */
export const tagText = (body: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
  return match ? match[1].trim() : null
}
