/* ── SettingsList ──
   The one list every settings page draws — now a thin adapter over the ported
   `components/ui/data-table.tsx`, so the seven pages that already call it get
   the full table without an edit each.

   What the adapter is for: `DataTable` speaks TanStack (`ColumnDef`, an
   accessor per column, a flat `actions` array), and a settings page speaks
   "name, detail, two buttons". This maps one onto the other and picks the
   defaults that suit a settings list — a view toggle, swipe rails on the
   cards, no pagination until a list is long enough to want one. A page that
   needs sorting, selection, grouping or a footer should reach for `DataTable`
   directly; everything it can do is still there.

   ── The two layouts ──
   `DataTable` keeps a table view and a card view and remembers which you chose,
   per viewport, in localStorage (`dataTable.desktopView` / `.mobileView`).
   Which viewport that is is the **panel's** width, not the window's
   (`useIsNarrow`, docs/client.md) — settings docked narrow beside a terminal
   opens as cards like a phone does, because it is as narrow as one. It is
   measured rather than a `@panel-*` query because the two views are different
   markup and only one is rendered; a container query can restyle a tree, not
   choose between two.

   ── Swipe ──
   A row action with `position: "left" | "right"` becomes a swipe rail on the
   card, and `showOn` keeps an action out of the view it does not suit. Delete
   defaults to the right rail (swipe left to reveal), which is the platform
   convention the ported gesture follows. */
import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { Empty } from "@/components/empty"
import {
  DataTable,
  type DataTableColumnMeta,
  type TableAction,
} from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import type { RowData } from "@tanstack/react-table"
import { cn } from "@/lib/utils"

/** One column, in the words a settings page uses. Mapped to a TanStack
    `ColumnDef` below — `cell` still receives the row, not a cell context. */
export interface ListColumn<T extends RowData> {
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** `end` for a number or a trailing status. */
  align?: "start" | "end"
  /** A Tailwind width class for the cell. */
  width?: string
  /** Hidden on a narrow table rather than forcing a horizontal scroll. The
      card view shows it regardless — that is what the card view is for. */
  secondary?: boolean
}

/** One row action. Re-exported shape of the table's own `TableAction`, minus
    the parts a settings list never sets. */
export interface ListAction<T extends RowData> {
  id: string
  label: string
  icon: React.ReactNode
  onClick: (row: T) => void
  hidden?: (row: T) => boolean
  disabled?: (row: T) => boolean
  tone?: TableAction<T>["tone"]
  /** Which swipe rail this action takes on a card. Defaults to the right. */
  position?: "left" | "right"
  showOn?: "desktop" | "mobile" | "both"
}

export interface SettingsListProps<T extends RowData> {
  columns: ListColumn<T>[]
  rows: T[]
  rowId: (row: T) => string
  actions?: ListAction<T>[]
  /** Opt in to the search box in the table's own filter bar. The predicate is
      the caller's: what a row is *called* differs per list (a name, a name and
      a command, a glob). */
  search?: {
    placeholder?: string
    matches: (row: T, needle: string) => boolean
  }
  /** Drawn instead of the table when there are no rows at all — a page's own
      `EmptyCard`, with its wording and its call to action. A search that
      matches nothing is a different sentence and stays inside the table. */
  empty?: React.ReactNode
  emptyIcon?: LucideIcon
  emptyText?: string
  loading?: boolean
  skeletonRows?: number
  /** A row as one card. Absent, the card is the first column over the second. */
  renderCard?: (row: T) => React.ReactNode
  onRowClick?: (row: T) => void
  /** Rows before the table pages itself. A settings list is usually shorter
      than this, in which case no pager is drawn at all. */
  pageSize?: number
  className?: string
}

export function SettingsList<T extends RowData>({
  columns,
  rows,
  rowId,
  actions,
  search,
  empty,
  emptyIcon,
  emptyText,
  loading = false,
  skeletonRows = 4,
  renderCard,
  onRowClick,
  pageSize = 25,
  className,
}: SettingsListProps<T>) {
  const [query, setQuery] = React.useState("")
  const needle = query.trim().toLowerCase()
  const shown = React.useMemo(
    () => (search && needle ? rows.filter((row) => search.matches(row, needle)) : rows),
    // `matches` is an inline arrow at every call site; the rows and the needle move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, needle]
  )

  /* `ColumnDef`s are rebuilt only when the caller's columns change. The table
     memoizes each row against them, so an unstable array here would defeat the
     per-row memo the port exists for. */
  const tableColumns = React.useMemo<ColumnDef<T, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header as string,
        /* Everything a settings list shows is rendered, not derived, so there
           is no accessor — sorting a column would need one, which is the
           natural place to add it if a list ever wants to sort. */
        cell: ({ row }) => column.cell(row.original),
        meta: {
          align: column.align,
          className: cn(column.width, column.secondary && "hidden @panel-md:table-cell"),
        } satisfies DataTableColumnMeta,
      })),
    [columns]
  )

  const tableActions = React.useMemo<TableAction<T>[]>(
    () =>
      (actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        icon: action.icon,
        tone: action.tone,
        onClick: action.onClick,
        hidden: action.hidden,
        disabled: action.disabled,
        position: action.position ?? "right",
        showOn: action.showOn ?? "both",
      })),
    [actions]
  )

  // Nothing at all, before any search — the page's own empty state.
  if (!loading && rows.length === 0) {
    return <>{empty ?? <Empty size="lg" icon={emptyIcon}>{emptyText ?? "Nothing here yet."}</Empty>}</>
  }

  return (
    <DataTable
      className={className}
      columns={tableColumns}
      data={shown}
      getRowId={(row) => rowId(row)}
      isLoading={loading}
      skeletonRows={skeletonRows}
      emptyMessage={needle ? `Nothing matches “${query.trim()}”.` : (emptyText ?? "No results.")}
      pageSize={pageSize}
      actions={tableActions}
      onRowClick={onRowClick}
      filtering={
        search
          ? {
              search: {
                value: query,
                onChange: setQuery,
                placeholder: search.placeholder ?? "Search…",
              },
            }
          : undefined
      }
      mobile={renderCard ? { renderRow: (row) => renderCard(row) } : undefined}
      viewToggle={Boolean(renderCard)}
    />
  )
}
