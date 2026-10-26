/* ── Key/value rows, drawn ──
   A form's named values — an agent's environment, an MCP server's environment
   and headers. All three were a `NAME=value` textarea, which asks a person to
   spell the punctuation that makes a row a row and gives back nothing when they
   get it wrong: a typo in the separator silently made the whole line the name.

   A row is two fields and a delete. `+ Add` appends one, a blank name is a row
   somebody abandoned, and a duplicate name is marked on the row that holds it
   rather than quietly overwriting on save. The rules themselves live in
   `lib/key-value-rows.ts`, which is what the tests hold.

   ── Why the value is one line ──
   An env value cannot hold a newline, and `{name, value}` is what the wire takes,
   so a single-line field is the honest control. That is also why this is not a
   general JSON editor: a *template* (`CODEX_CONFIG`) is a several-thousand-
   character object, and callers put those behind a fold with a textarea
   (`agent-env.tsx`) instead of pretending a row can hold one. */
import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/busy-button"
import { Input } from "@/components/ui/input"
import { blankRow, duplicateNames, type KeyValueRow } from "@/lib/key-value-rows"

/**
 * A list of named values.
 *
 * `nameValidator` is what makes this more than a pair of inputs: an environment
 * key and an HTTP header name have different grammars, and the component says
 * which rows are wrong in the caller's own words rather than growing a rule per
 * caller.
 */
export function KeyValueRows({
  rows,
  onChange,
  namePlaceholder = "NAME",
  valuePlaceholder = "value",
  addLabel = "Add",
  nameLabel = "Name",
  valueLabel = "Value",
  nameValidator,
  invalidHint,
  duplicateHint = "Two rows use this name — only the last one is kept.",
}: {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  namePlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
  nameLabel?: string
  valueLabel?: string
  /** Whether a name is well-formed; absent means anything non-empty. */
  nameValidator?: (name: string) => boolean
  /** What to say on a row whose name the validator refused. */
  invalidHint?: string
  duplicateHint?: string
}) {
  const duplicates = React.useMemo(() => duplicateNames(rows, { caseInsensitive: true }), [rows])

  const patch = (id: string, change: Partial<KeyValueRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...change } : row)))
  const remove = (id: string) => onChange(rows.filter((row) => row.id !== id))
  const add = () => onChange([...rows, blankRow()])

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, index) => {
            const name = row.name.trim()
            const dup = name !== "" && duplicates.has(name.toLowerCase())
            const bad = name !== "" && !!nameValidator && !nameValidator(name)
            return (
              <li key={row.id}>
                <div className="flex items-start gap-1.5">
                  <Input
                    value={row.name}
                    onChange={(e) => patch(row.id, { name: e.target.value })}
                    placeholder={namePlaceholder}
                    aria-label={`${nameLabel} ${index + 1}`}
                    aria-invalid={dup || bad || undefined}
                    className="min-w-0 flex-[2] font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => patch(row.id, { value: e.target.value })}
                    placeholder={valuePlaceholder}
                    aria-label={`${valueLabel} ${index + 1}`}
                    className="min-w-0 flex-[3] font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 pointer-coarse:size-11"
                    title={`Remove ${name || "this row"}`}
                    aria-label={`Remove ${name || `row ${index + 1}`}`}
                    onClick={() => remove(row.id)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
                {bad && invalidHint && <p className="mt-1 pl-0.5 text-xs text-destructive">{invalidHint}</p>}
                {!bad && dup && <p className="mt-1 pl-0.5 text-xs text-destructive">{duplicateHint}</p>}
              </li>
            )
          })}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={add}>
        <PlusIcon data-icon="inline-start" />
        {addLabel}
      </Button>
    </div>
  )
}
