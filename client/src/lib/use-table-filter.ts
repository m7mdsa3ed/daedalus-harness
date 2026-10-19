import * as React from "react"
import type { DataTableFiltering } from "@/components/ui/data-table"

export interface TableFilterField<T> {
  id: string
  label: string
  /** The value a row has for this field; its distinct values become the options. */
  of: (row: T) => string | null | undefined
  /** Display text for a value, when the value itself is a code (`"stdio"` → `"Command"`). */
  optionLabel?: (value: string) => string
}

/* Search + multi-select filters for a DataTable, derived from the rows
   themselves: one call gives the filtered rows and the `filtering` prop.
   A field with fewer than two distinct values is not drawn — it could not
   narrow anything. Empty selection means "all". */
export function useTableFilter<T>(
  rows: T[],
  opts: { text?: (row: T) => string; matches?: (row: T, needle: string) => boolean; placeholder?: string; fields?: TableFilterField<T>[] },
) {
  const [query, setQuery] = React.useState("")
  const [values, setValues] = React.useState<Record<string, string[]>>({})
  const needle = query.trim().toLowerCase()

  /* `opts` is an inline object at every call site; the rows, the needle and the picks move. */
  /* eslint-disable react-hooks/exhaustive-deps */
  const fields = React.useMemo(
    () =>
      (opts.fields ?? []).flatMap((f) => {
        const distinct = [...new Set(rows.map(f.of).filter((v): v is string => Boolean(v)))].sort()
        return distinct.length < 2
          ? []
          : [{
              id: f.id,
              label: f.label,
              type: "multi-select" as const,
              options: distinct.map((value) => ({ value, label: f.optionLabel?.(value) ?? value })),
            }]
      }),
    [rows],
  )
  const shown = React.useMemo(
    () =>
      rows.filter(
        (row) =>
          (!needle || (opts.matches ? opts.matches(row, needle) : (opts.text?.(row) ?? "").toLowerCase().includes(needle))) &&
          (opts.fields ?? []).every((f) => {
            const picked = values[f.id]
            return !picked?.length || picked.includes(f.of(row) ?? "")
          }),
      ),
    [rows, needle, values],
  )
  /* eslint-enable react-hooks/exhaustive-deps */

  const count = Object.values(values).filter((v) => v.length).length
  const filtering: DataTableFiltering = {
    search: { value: query, onChange: setQuery, placeholder: opts.placeholder ?? "Search…" },
    fields,
    values,
    onChange: (id, value) => setValues((p) => ({ ...p, [id]: Array.isArray(value) ? value : [] })),
    count,
    onClear: () => setValues({}),
    totalCount: rows.length,
  }
  return { rows: shown, filtering, narrowed: Boolean(needle) || count > 0, query }
}
