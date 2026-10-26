/* ── Named values: the logic, with no view in it ──
   A form's key/value rows — an agent's environment, an MCP server's environment
   and headers — are `{name, value}` pairs with three rules that are worth
   getting right once and testing without a browser:

     - a row with a blank name is a row somebody abandoned, not a variable;
     - a name that is not a legal variable name is a mistake to *report*, never to
       drop, because dropping it makes the save claim success about a variable
       that no longer exists;
     - a duplicate name is the last one's, which is what a process would see.

   `components/settings/key-value-rows.tsx` is the drawing of this, and
   `components/settings/agent-env.tsx` is the three-way split of an agent's env
   built on it. Both are views; this file is the part a test can hold. */

export interface KeyValueRow {
  /** Stable across renames, so a row's input keeps focus while its name is
      typed and React does not re-mount every keystroke. */
  id: string
  name: string
  value: string
}

/** A variable name a process can actually receive. A spawn would happily carry
    `MY FLAG` through to `child_process`, which drops it — so a name that is not
    this shape is a variable that silently does not exist. */
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Rows from a record, in the record's own order. */
export function rowsFromRecord(record: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ id: name, name, value }))
}

/** A fresh, empty row — what `+ Add` appends. `id` is a counter because two
    blank rows have no name to tell them apart by. */
let seq = 0
export const blankRow = (): KeyValueRow => ({ id: `kv-${(seq += 1)}`, name: "", value: "" })

/** Rows back to a record. Blank names are dropped; a later duplicate wins. */
export function recordFromRows(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    out[name] = row.value
  }
  return out
}

/** Names that appear more than once, so the form can mark the rows and refuse
    the save. Lowercased for env keys: they are case-sensitive on the wire, but
    `FOO` and `foo` in one box is a mistake worth naming either way. */
export function duplicateNames(rows: KeyValueRow[], opts: { caseInsensitive?: boolean } = {}): Set<string> {
  const key = (name: string) => (opts.caseInsensitive ? name.toLowerCase() : name)
  const counts = new Map<string, number>()
  for (const row of rows) {
    const name = row.name.trim()
    if (name) counts.set(key(name), (counts.get(key(name)) ?? 0) + 1)
  }
  const dups = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (name && (counts.get(key(name)) ?? 0) > 1) dups.add(key(name))
  }
  return dups
}

/** Rows whose name is not a legal variable name. Empty is not invalid — it is a
    row being typed, and `recordFromRows` drops it. */
export function invalidEnvNames(rows: KeyValueRow[]): Set<string> {
  const bad = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (name && !ENV_KEY.test(name)) bad.add(name)
  }
  return bad
}
