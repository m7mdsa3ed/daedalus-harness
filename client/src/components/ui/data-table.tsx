import * as React from "react";
import type { ReactNode } from "react";
import { flexRender } from "@tanstack/react-table";
import { type ColumnDef, type Row, useAppTable } from "@/lib/table";
import type { RowData } from "@tanstack/react-table";

/** Per-column presentation a page can set on `ColumnDef.meta`. Read by the
 *  header, the body cells and the footer, so a column lines up in all three. */
export interface DataTableColumnMeta {
  align?: "start" | "end";
  /** Extra classes for this column's header and cells — a width, or a
   *  responsive hide for a column not worth a horizontal scroll. */
  className?: string;
  /** Marks the title column: the one a row is *called*. It gets the title
   *  type, the leading `mark`; on the narrow list it is the row's heading. Defaults to the first column. */
  title?: boolean;
}

const columnMeta = (column: { columnDef: { meta?: unknown } }) =>
  (column.columnDef.meta ?? {}) as DataTableColumnMeta;
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsUpDown,
  Inbox,
  List,
  Rows3,
  MoreHorizontal,
  MoreVertical,
  Table2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyContent, EmptyDescription, EmptyMedia } from "@/components/ui/empty";
import { Checkbox } from "@/components/ui/checkbox";
import {

  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PaginationControls } from "@/components/pagination-controls";
import { SwipeableRow } from "@/components/swipeable-row";
import type { SwipeNeighborMotion } from "@/components/motion/swipeable-list";
import { useMotionValue } from "motion/react";
import { HeaderActionOverflow } from "@/components/ui/action-overflow";
import { useIsNarrow } from "@/hooks/use-device";
import { MENU_WIDTH } from "@/components/menu-row";
import { KEYBOARD_RISE } from "@/lib/keyboard-inset";
import {
  FiltersBar,
  type FilterFieldDef,
  type FilterSchemaValue,
} from "@/components/ui/filters-bar";


export interface TableAction<TData> {
  id: string;
  /** The words, or a function of the row when they depend on it — "Show" on a
      hidden profile, "Hide" otherwise. Never a state name: it reads as the
      action it performs. */
  label: string | ((row: TData) => string);
  /** The mark, resolved the same way and for the same reason. */
  icon: ReactNode | ((row: TData) => ReactNode);
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
  onClick: (row: TData) => void;
  showOn?: "desktop" | "mobile" | "both";
  /** Which swipe rail this action lives on for the mobile card. Defaults to "right"
   *  (revealed by swiping the row left). "left" reveals by swiping right. */
  position?: "left" | "right";
  /** Hide this action for rows where it doesn't apply. */
  hidden?: (row: TData) => boolean;
  /** Render the action but disabled for rows where it isn't currently actionable. */
  disabled?: (row: TData) => boolean;
}

/** A table action's words and mark, which may be per row (Show/Hide). */
function actionLabel<TData>(action: TableAction<TData>, row: TData): string {
  return typeof action.label === "function" ? action.label(row) : action.label;
}

function actionIcon<TData>(action: TableAction<TData>, row: TData): ReactNode {
  return typeof action.icon === "function" ? action.icon(row) : action.icon;
}

const ACTION_TONE_TEXT: Record<
  NonNullable<TableAction<unknown>["tone"]>,
  string
> = {
  neutral: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

const ACTION_TONE_SWIPE_BG: Record<
  NonNullable<TableAction<unknown>["tone"]>,
  string
> = {
  neutral: "",
  primary: "bg-primary text-primary-foreground",
  success: "bg-success text-white",
  warning: "bg-warning text-white",
  danger: "bg-destructive text-white",
};

export interface BulkAction<TData> {
  id: string;
  label: string;
  icon: ReactNode;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
  onClick: (selected: TData[]) => void;
  /** Hide this action for selections it doesn't apply to (e.g. "Group" needs 2+). */
  hidden?: (selected: TData[]) => boolean;
  disabled?: (selected: TData[]) => boolean;
}

export interface DataTablePagination {
  /** 1-based current page. */
  page: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  onPageChange: (page: number) => void;
  /** Current rows-per-page. Providing `onLimitChange` renders the page-size dropdown. */
  limit?: number;
  onLimitChange?: (limit: number) => void;
}

export const PAGE_SIZE_OPTIONS = [15, 25, 50, 100];

// Table/cards preference — shared across every DataTable so a user's choice
// on one list applies everywhere until they change it. Desktop and mobile
// remember their own choice (mobile defaults to cards, desktop to table).
const VIEW_STORAGE_KEY = {
  desktop: "dataTable.desktopView",
  mobile: "dataTable.mobileView",
} as const;
const VIEW_DEFAULT = { desktop: "table", mobile: "cards" } as const;
function readView(viewport: "desktop" | "mobile"): "table" | "cards" {
  const stored = localStorage.getItem(VIEW_STORAGE_KEY[viewport]);
  return stored === "cards" || stored === "table"
    ? stored
    : VIEW_DEFAULT[viewport];
}

export interface DataTableSort {
  id: string;
  desc: boolean;
}

/** Row-detail accordion. Uncontrolled by default — pass `rowId`/`onRowIdChange`
 *  only when a page needs to read or drive which row is open. */
export interface DataTableExpand<TData> {
  /** Full-width detail panel rendered as a second table row beneath the open one. */
  render: (row: TData) => React.ReactNode;
  /** Controlled open row (a `getRowId` value, or null). Requires `onRowIdChange`. */
  rowId?: string | null;
  onRowIdChange?: (rowId: string | null) => void;
  /** Server-loaded panels: while true the table renders a skeleton in place of
   *  `render`, so every page's lazy-fetched detail looks the same. Pair with a
   *  query enabled on the open row — see `expandedRowId` via `onRowIdChange`. */
  loading?: (row: TData) => boolean;
}

/** Presentational grouping of already-flat rows into contiguous segments. */
export interface DataTableGrouping<TData> {
  /** Group key for a row; `undefined` leaves the row ungrouped. */
  by: (row: TData) => string | undefined;
  renderHeader?: (
    groupKey: string,
    firstRow: TData,
    isExpanded: boolean,
    onToggle: () => void,
  ) => React.ReactNode;
  /**
   * Mobile counterpart to `renderHeader`. When provided, the mobile list wraps
   * each real group (non-null return) in a bordered container with this header
   * on top. Return `null` for keys that shouldn't get a header (e.g. singletons)
   * — those rows render as standalone cards. Groups are expanded by default.
   */
  renderMobileHeader?: (
    groupKey: string,
    firstRow: TData,
    isExpanded: boolean,
    onToggle: () => void,
  ) => React.ReactNode;
}

/** Row selection + the bulk actions it drives. */
export interface DataTableSelection<TData> {
  /** Controlled selection. When provided (with `onChange`), the table
   *  reads/writes this set instead of its internal state. */
  ids?: Set<string>;
  onChange?: (ids: Set<string>) => void;
  /** Rendered in the shared <BulkActionBar> (inline on desktop, fixed bottom
   *  bar on mobile) whenever the selection is non-empty. */
  bulkActions?: BulkAction<TData>[];
  /** Server-side total. With `onSelectAllMatching`, the bar offers to extend a
   *  full-page selection to every matching row. */
  totalCount?: number;
  onSelectAllMatching?: () => void;
  /** Escape hatch that replaces the bar entirely. */
  renderToolbar?: (selected: TData[], clear: () => void) => React.ReactNode;
}

/** Search + declarative filters rendered in the table's own filter bar. */
export interface DataTableFiltering {
  fields?: FilterFieldDef[];
  /** Current values keyed by field id (page-owned; URL-synced). */
  values?: FilterSchemaValue;
  onChange?: (id: string, value: string[] | string | boolean) => void;
  /** Number of active filters — shown as a badge on the Filters button. */
  count?: number;
  /** Clear-all handler; shows a clear button in the popover when `count` > 0. */
  onClear?: () => void;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** How many rows exist before the search/filters narrowed them. With it, the
   *  toolbar says "12 of 40" while a search or filter is active. */
  totalCount?: number;
}

/** A generic icon action rendered in the table's own filter bar (e.g. refresh,
 *  export) — for actions on the table as a whole, not a specific row. */
export interface DataTableToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Navigate on click (renders a Link). Mutually exclusive with `onClick`. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Show `label` as inline text next to the icon instead of tooltip-only —
   *  for actions ambiguous by icon alone (e.g. two refresh-shaped icons). */
  showLabel?: boolean;
}

/** The mobile card list that replaces the table below `md`. */
export interface DataTableMobile<TData extends RowData> {
  renderRow?: (
    row: TData,
    helpers: {
      cell: (id: string) => React.ReactNode;
      getValue: (id: string) => unknown;
      row: Row<TData>;
    },
  ) => React.ReactNode;
  /** Loading placeholder for one card. Defaults to a generic two-line card —
   *  override when the real card has a distinctly different shape. */
  rowSkeleton?: React.ReactNode;
  /** Overrides the flat list container. When set, rows render directly (no card
   *  chrome / dividers) — each row owns its styling, which is what
   *  `renderFullRow` cards want. */
  listClassName?: string;
}

export interface DataTableProps<TData extends RowData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  /** Stable row id (defaults to the row index). Required for controlled selection. */
  getRowId?: (row: TData, index: number) => string;
  isLoading?: boolean;
  skeletonRows?: number;
  emptyMessage?: React.ReactNode;
  /** Client-side pagination page size (default 15 — keeps large lists cheap to
   *  mount). Mutually exclusive with `pagination`. */
  pageSize?: number;
  /** Server-side pagination — renders the shared <PaginationControls>. */
  pagination?: DataTablePagination;
  /** Suppress the internal rows-per-page select — for pages that render it
   *  themselves (e.g. inside <PageToolbar>). */
  hidePageSize?: boolean;
  /** Server-side sorting: the table stops sorting rows itself and reports
   *  header clicks through `onSortingChange` instead. */
  manualSorting?: boolean;
  sorting?: DataTableSort | null;
  onSortingChange?: (sort: DataTableSort | null) => void;
  onRowClick?: (row: TData) => void;
  /** When provided, clicking a row toggles its detail panel, taking precedence
   *  over `onRowClick` (pages navigate from a View action instead of the tap). */
  expand?: DataTableExpand<TData>;
  rowClassName?: (row: TData, index: number) => string | undefined;
  grouping?: DataTableGrouping<TData>;
  /** Escape hatch for rows that need to own their entire line: return non-null
   *  to replace the row's cells with a single full-width cell on desktop and a
   *  custom card on mobile (selection/actions columns included in the span). */
  renderFullRow?: (
    row: TData,
    layout: "desktop" | "mobile",
    index: number,
  ) => React.ReactNode | null;
  filtering?: DataTableFiltering;
  actions?: TableAction<TData>[];
  /** Icon buttons rendered in the filter bar, next to the rows-per-page select
   *  (e.g. a refresh button) — table-level, not per-row. */
  toolbarActions?: DataTableToolbarAction[];
  selection?: DataTableSelection<TData>;
  mobile?: DataTableMobile<TData>;
  /** Shows a table/cards toggle so users can override the layout instead of
   *  it being forced by viewport (desktop defaults to table, mobile to
   *  cards — each remembered separately). Defaults to on; only takes effect
   *  when `mobile.renderRow` or `renderFullRow` is set. Set to `false` to
   *  force table on desktop and cards on mobile. */
  viewToggle?: boolean;
  className?: string;
  /** A data-driven footer: a `<tfoot>` on desktop and a totals strip at the
   *  bottom of the mobile card list. Each cell carries its own renderer and
   *  loading state, positioned under the matching table column. */
  footer?: DataTableFooter;
  /** The leading mark of a row — an avatar, an icon, a logo. Drawn at the start
   *  of the title cell on the table and in the mark slot of the default narrow
   *  row. Also turns the table/list toggle on (the list is worth choosing). */
  mark?: (row: TData) => ReactNode;
  /** Free-form controls for the toolbar, between the filters and the view
   *  toggle (e.g. an "Add" button). */
  toolbar?: ReactNode;
  /** Glyph and call to action for the empty state. */
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
  /** Caps the table's height so its header stays put while the rows scroll
   *  (a CSS length, or px). Unset, the page scrolls and the table grows. */
  maxHeight?: number | string;
}

/** One footer cell: a value rendered under the matching table column (desktop)
 *  or as a label/value row (mobile). The page supplies the data via `render`. */
export interface DataTableFooterCell {
  /** Column id this cell sits under. */
  columnId: string;
  /** Render the cell content (e.g. a server total). */
  render: () => React.ReactNode;
  /** Right-align this cell on desktop. Defaults to the column's `meta.align`. */
  align?: "start" | "end";
  /** Show a skeleton in this cell instead of `render` while its data loads. */
  loading?: boolean;
}

/** Footer definition a page passes to render a summary row. */
export interface DataTableFooter {
  /** Optional leading label, left-aligned in the first column (e.g. "Total"). */
  label?: React.ReactNode;
  cells: DataTableFooterCell[];
}

/** Per-row slice of table state that a single row actually re-renders on. */
interface RowFlags {
  sel: boolean;
  exp: boolean;
}

/**
 * Structural type for `table.Subscribe` in store mode.
 *
 * Rows receive this rather than `table`: the table object is created once and
 * hydrated with option merges, but passing the whole `table` couples each row
 * to every table-state change. `Subscribe` + `rowFlagsSelector` let a row
 * re-render only for its own selected/expanded slice.
 */
type RowSubscribe = (props: {
  selector: (state: any) => RowFlags;
  children: (value: RowFlags) => React.ReactNode;
}) => React.ReactNode;

/** Reads one row's selected/expanded flags out of the full table state. */
const rowFlagsSelector = (rowId: string) => (s: any): RowFlags => ({
  sel: Boolean(s.rowSelection?.[rowId]),
  exp: Boolean(s.expanded?.[rowId]),
});

/* ── Shared look ──
   Named once so the header and the body agree. */

/** 2px primary bar on a selected row's start edge — drawn by the row's first
 *  cell so it follows the row in both directions and shifts nothing. */
const SELECT_BAR =
  "relative before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-primary before:opacity-0 group-data-[state=selected]/row:before:opacity-100";
/** Row actions are present on hover/focus/selection and on touch, never by
 *  moving layout: only opacity changes. */
const REVEAL =
  "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[state=selected]/row:opacity-100 group-aria-expanded/row:opacity-100 data-popup-open:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100";
/** The sticky header's hairline is an inset shadow: a collapsed border does not
 *  travel with a sticky cell. */
const HEAD_BG =
  "bg-card shadow-[inset_0_-1px_0_var(--border)]";
/** Mark slot at the start of a title cell / list row. */
const MARK_BOX =
  "flex shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground [&_svg:not([class*='size-'])]:size-4";

/** Title + optional muted second line, the shape a title cell wants. A column
 *  may render this, or anything else — it is a convenience, not a contract. */
export function TitleCell({
  title,
  subtitle,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm font-medium">{title}</div>
      {subtitle ? (
        <div className="truncate text-xs font-normal text-muted-foreground">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

/** Up to two inline icon buttons; the rest — destructive ones last — fold into
 *  a menu. Two or fewer are never folded. */
function splitActions<TData>(actions: TableAction<TData>[]) {
  if (actions.length <= 2) return { inline: actions, overflow: [] };
  const calm = actions.filter((a) => a.tone !== "danger");
  const danger = actions.filter((a) => a.tone === "danger");
  return {
    inline: calm.slice(0, 2),
    overflow: [...calm.slice(2), ...danger],
  };
}

/** Items of an actions menu — shared by the desktop "more" and the phone's. */
function ActionMenuItems<TData>({
  actions,
  row,
}: {
  actions: TableAction<TData>[];
  row: TData;
}) {
  const danger = actions.filter((a) => a.tone === "danger");
  const calm = actions.filter((a) => a.tone !== "danger");
  const item = (a: TableAction<TData>) => (
    <DropdownMenuItem
      key={a.id}
      disabled={a.disabled?.(row)}
      variant={a.tone === "danger" ? "destructive" : "default"}
      onClick={(e) => {
        e.stopPropagation();
        a.onClick(row);
      }}
      className={cn(
        "pointer-coarse:min-h-11",
        a.tone && a.tone !== "danger" && a.tone !== "neutral" && ACTION_TONE_TEXT[a.tone],
      )}
    >
      {actionIcon(a, row)}
      {actionLabel(a, row)}
    </DropdownMenuItem>
  );
  return (
    <>
      {calm.map(item)}
      {calm.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
      {danger.map(item)}
    </>
  );
}

/** A three-dots menu over a set of row actions. */
function ActionMenu<TData>({
  actions,
  row,
  className,
  icon,
}: {
  actions: TableAction<TData>[];
  row: TData;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title="More actions"
            aria-label="More actions"
            className={cn("text-muted-foreground hover:text-foreground", className)}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        {icon ?? <MoreHorizontal className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_WIDTH}>
        <ActionMenuItems actions={actions} row={row} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One desktop `<tr>` (plus its expanded detail `<tr>`), subscribed to just its
 * own selection/expansion. Toggling a checkbox or expanding a row re-renders
 * this row alone instead of rebuilding the whole table body. `React.memo`
 * holds because every prop is referentially stable across page re-renders
 * (pages memoize their columns/actions/expanded-row renderers).
 */
interface DesktopRowProps<TData extends RowData> {
  row: Row<TData>;
  index: number;
  Subscribe: RowSubscribe;
  hasSelection: boolean;
  hasExpandableRows: boolean;
  hasActions: boolean;
  expandColSpan: number;
  titleColumnId?: string;
  mark?: (row: TData) => ReactNode;
  onRowClick?: (row: TData) => void;
  onToggleExpanded: (rowId: string) => void;
  onToggleSelected: (rowId: string) => void;
  rowClassName?: (row: TData, index: number) => string | undefined;
  renderExpandedRow?: (row: TData) => React.ReactNode;
  expandLoading?: (row: TData) => boolean;
  renderActionsColumn: (row: TData) => React.ReactNode;
}

/* `React.memo` erases a generic component's type parameter — it returns a
   plain `MemoExoticComponent` fixed at whatever `TData` inferred to, which is
   `RowData`. Every `TData` callback the table hands down then fails to match.
   The cast puts the generic signature back; the memo itself is unaffected.
   (The upstream project never saw this: it compiles with `strict: false`.) */
const DesktopRow = React.memo(function DesktopRow<TData extends RowData>({
  row,
  index,
  Subscribe,
  hasSelection,
  hasExpandableRows,
  hasActions,
  expandColSpan,
  titleColumnId,
  mark,
  onRowClick,
  onToggleExpanded,
  onToggleSelected,
  rowClassName,
  renderExpandedRow,
  expandLoading,
  renderActionsColumn,
}: DesktopRowProps<TData>) {
  const activate = () => {
    if (hasExpandableRows) onToggleExpanded(row.id);
    else onRowClick?.(row.original);
  };
  const interactive = Boolean(onRowClick || hasExpandableRows);
  return (
    <Subscribe selector={rowFlagsSelector(row.id)}>
      {({ sel, exp }) => (
        <>
          <TableRow
            data-state={sel ? "selected" : undefined}
            aria-expanded={hasExpandableRows ? exp : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={activate}
            onKeyDown={
              interactive
                ? (e) => {
                    // Only the row itself: Space on a checkbox inside it is the checkbox's.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      activate();
                    }
                  }
                : undefined
            }
            className={cn(
              "group/row h-14 outline-none hover:bg-muted/50 data-[state=selected]:bg-primary/5 data-[state=selected]:hover:bg-primary/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/70",
              interactive && "cursor-pointer",
              rowClassName?.(row.original, index),
            )}
          >
            {hasSelection && (
              <TableCell
                className={cn(
                  "w-12 py-3 ps-4 pe-0",
                  SELECT_BAR,
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={sel}
                  onCheckedChange={() => onToggleSelected(row.id)}
                  aria-label="Select row"
                  className="size-4"
                />
              </TableCell>
            )}
            {row.getVisibleCells().map((cell, cellIndex) => {
              const meta = columnMeta(cell.column);
              const isTitle = cell.column.id === titleColumnId;
              const first = cellIndex === 0;
              const content = flexRender(
                cell.column.columnDef.cell,
                cell.getContext(),
              );
              return (
                <TableCell
                  key={cell.id}
                  className={cn(
                    "px-3 py-3",
                    isTitle && "min-w-48 max-w-[28rem] text-sm font-medium",
                    first && !hasSelection && ["ps-4", SELECT_BAR],
                    meta.align === "end" && "text-end tabular-nums",
                    meta.className,
                  )}
                >
                  {isTitle && mark ? (
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={cn(MARK_BOX, "size-9 rounded-lg")}>{mark(row.original)}</div>
                      <div className="min-w-0 flex-1">{content}</div>
                    </div>
                  ) : (
                    content
                  )}
                </TableCell>
              );
            })}
            {hasActions && (
              <TableCell
                className="w-px py-3 ps-1 pe-3 text-end"
                onClick={(e) => e.stopPropagation()}
              >
                {renderActionsColumn(row.original)}
              </TableCell>
            )}
          </TableRow>
          {/* Only built when open — previously `render` ran for every collapsed
              row on every render. */}
          {exp && hasExpandableRows && (
            <TableRow className="border-b-0 bg-muted/50 hover:bg-muted/50">
              <TableCell colSpan={expandColSpan}>
                {expandLoading?.(row.original) ? (
                  <ExpandedRowSkeleton />
                ) : (
                  renderExpandedRow!(row.original)
                )}
              </TableCell>
            </TableRow>
          )}
        </>
      )}
    </Subscribe>
  );
}) as <TData extends RowData>(props: DesktopRowProps<TData>) => React.ReactElement;

/**
 * One mobile row. The `Subscribe` boundary wraps the whole `SwipeableRow`,
 * so the swipe rail's Select/Deselect state and the tap-to-select behavior
 * both track this row's selected flag alone.
 *
 * `flat` is the default continuous list: a square row on the surface, divided
 * from its neighbours by the list's hairlines, with a leading checkbox (when
 * selectable) and a visible "more" menu so actions don't hide behind a swipe.
 * Not flat, it is the old floating card the `listClassName` escape hatch owns.
 */
interface MobileCardProps<TData extends RowData> {
  row: Row<TData>;
  rowIndex: number;
  wrapperClassName?: string;
  flat: boolean;
  Subscribe: RowSubscribe;
  renderMobileRow: (row: TData, helpers: any) => React.ReactNode;
  helpersFor: (row: Row<TData>) => {
    cell: (id: string) => React.ReactNode;
    getValue: (id: string) => unknown;
    row: Row<TData>;
  };
  swipeActionsFor: (row: TData) => {
    left: { label: string; icon: ReactNode; className: string; onClick: () => void }[];
    right: { label: string; icon: ReactNode; className: string; onClick: () => void }[];
  };
  menuActionsFor: (row: TData) => TableAction<TData>[];
  hasSelection: boolean;
  isAnySelected: () => boolean;
  onRowClick?: (row: TData) => void;
  onToggleSelected: (rowId: string) => void;
  rowClassName?: (row: TData, index: number) => string | undefined;
  neighborMotion: SwipeNeighborMotion;
  neighborIndex: number;
  neighborScope: string;
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 8;

/* Generic-through-memo, as DesktopRow above. */
const MobileCard = React.memo(function MobileCard<TData extends RowData>({
  row,
  rowIndex,
  wrapperClassName,
  flat,
  Subscribe,
  renderMobileRow,
  helpersFor,
  swipeActionsFor,
  menuActionsFor,
  hasSelection,
  isAnySelected,
  onRowClick,
  onToggleSelected,
  rowClassName,
  neighborMotion,
  neighborIndex,
  neighborScope,
}: MobileCardProps<TData>) {
  const helpers = helpersFor(row);
  const content = renderMobileRow(row.original, helpers);
  const swipe = swipeActionsFor(row.original);
  const menuActions = flat ? menuActionsFor(row.original) : [];
  const tappable = Boolean(onRowClick);

  // Long-press enters selection mode. The press that fires must not also be a
  // tap, so `fired` swallows the click the lift produces.
  const press = React.useRef({ timer: 0, x: 0, y: 0, fired: false });
  const cancelPress = () => {
    window.clearTimeout(press.current.timer);
    press.current.timer = 0;
  };
  React.useEffect(() => cancelPress, []);

  return (
    <Subscribe selector={rowFlagsSelector(row.id)}>
      {({ sel }) => {
        const selectAction = hasSelection
          ? {
              label: sel ? "Deselect" : "Select",
              // Purely visual checkbox (a real <Checkbox> renders a <button>,
              // which is invalid inside the swipe rail's action <button>).
              icon: (
                <span
                  aria-hidden
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full border",
                    sel
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background",
                  )}
                >
                  {sel && <Check className="h-3 w-3" />}
                </span>
              ),
              className: ACTION_TONE_SWIPE_BG.primary,
              onClick: () => onToggleSelected(row.id),
            }
          : undefined;

        const hasSwipe =
          swipe.left.length > 0 ||
          swipe.right.length > 0 ||
          selectAction !== undefined;

        const inner = (
          <div
            className={cn(
              "flex w-full min-w-0 items-center gap-1",
              flat && "self-stretch",
              !flat && sel && "opacity-80",
            )}
          >
            {flat && hasSelection && (
              // 44px target around a 16px box; stops the row's own tap.
              <div
                className="-ms-2 flex size-11 shrink-0 items-center justify-center"
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={sel}
                  onCheckedChange={() => onToggleSelected(row.id)}
                  aria-label="Select row"
                  className="size-4"
                />
              </div>
            )}
            <div
              className={cn(
                "min-w-0 flex-1",
                flat && "flex items-center self-stretch py-3",
                tappable && "rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
              )}
              onPointerDown={(e) => {
                if (!hasSelection || e.pointerType === "mouse") return;
                press.current.x = e.clientX;
                press.current.y = e.clientY;
                press.current.fired = false;
                cancelPress();
                press.current.timer = window.setTimeout(() => {
                  press.current.timer = 0;
                  press.current.fired = true;
                  navigator.vibrate?.(8);
                  onToggleSelected(row.id);
                }, LONG_PRESS_MS);
              }}
              onPointerMove={(e) => {
                if (
                  press.current.timer &&
                  Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) >
                    LONG_PRESS_SLOP
                )
                  cancelPress();
              }}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              onClick={(e) => {
                if (press.current.fired) {
                  press.current.fired = false;
                  e.stopPropagation();
                  return;
                }
                // In selection mode, tap toggles selection instead of navigating.
                if (hasSelection && isAnySelected()) {
                  e.stopPropagation();
                  onToggleSelected(row.id);
                  return;
                }
                if (onRowClick) {
                  e.stopPropagation();
                  onRowClick(row.original);
                }
              }}
              onContextMenu={(e) => e.preventDefault()}
              // A tappable row is a button to everything but the pointer. Only
              // the row itself answers the key: a control inside it keeps its own.
              role={tappable ? "button" : undefined}
              tabIndex={tappable ? 0 : undefined}
              onKeyDown={
                tappable
                  ? (e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (hasSelection && isAnySelected()) onToggleSelected(row.id);
                        else onRowClick!(row.original);
                      }
                    }
                  : undefined
              }
            >
              <div className="min-w-0 flex-1">{content}</div>
            </div>
            {menuActions.length > 0 && (
              <ActionMenu
                actions={menuActions}
                row={row.original}
                className="-me-1 size-11 shrink-0"
                icon={<MoreVertical className="size-4" />}
              />
            )}
          </div>
        );

        const card = (
          <div
            className={cn(
              flat
                ? cn(
                    "relative flex min-h-16 items-center ps-4 pe-2 transition-colors before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-primary before:opacity-0",
                    sel && "bg-primary/5 before:opacity-100",
                  )
                : (wrapperClassName ??
                    "flex items-center gap-3 bg-card p-3 frame-2xl frame-p-3 ring-1 ring-foreground/10"),
              tappable && "cursor-pointer active:bg-muted transition-colors",
              !flat && sel && "ring-2 ring-primary ring-inset rounded-2xl",
              rowClassName?.(row.original, rowIndex),
            )}
          >
            {inner}
          </div>
        );

        // Swipe-to-reveal row actions on mobile.
        // Right-rail actions reveal on swipe-left; left-rail on swipe-right.
        const left = selectAction ? [...swipe.left, selectAction] : swipe.left;
        return (
          <SwipeableRow
            key={row.id}
            onSwipeLeft={swipe.right.length ? swipe.right : undefined}
            onSwipeRight={left.length ? left : undefined}
            disabled={!hasSwipe}
            flat={flat}
            className="overflow-hidden"
            neighborMotion={neighborMotion}
            neighborIndex={neighborIndex}
            neighborScope={neighborScope}
          >
            {card}
          </SwipeableRow>
        );
      }}
    </Subscribe>
  );
}) as <TData extends RowData>(props: MobileCardProps<TData>) => React.ReactElement;

export function DataTable<TData extends RowData, TValue>({
  columns,
  data,
  getRowId,
  isLoading = false,
  skeletonRows = 6,
  emptyMessage,
  pageSize = PAGE_SIZE_OPTIONS[0],
  pagination,
  hidePageSize = false,
  manualSorting = false,
  sorting,
  onSortingChange,
  onRowClick,
  expand,
  rowClassName,
  grouping,
  renderFullRow,
  filtering,
  actions,
  toolbarActions,
  selection,
  mobile,
  viewToggle = true,
  className,
  footer,
  mark,
  toolbar: toolbarSlot,
  emptyIcon,
  emptyAction,
  maxHeight,
}: DataTableProps<TData, TValue>) {
  // Feature groups are unpacked into flat locals: the namespaces exist for the
  // call sites, the body reads one name per concern.
  const {
    by: groupBy,
    renderHeader: renderGroupHeader,
    renderMobileHeader: renderMobileGroupHeader,
  } = grouping ?? {};
  const {
    ids: selectedIdsProp,
    onChange: onSelectedIdsChange,
    bulkActions,
    totalCount: selectionTotalCount,
    onSelectAllMatching,
    renderToolbar: renderSelectionToolbar,
  } = selection ?? {};
  const {
    fields: filters,
    values: filterValues = {},
    onChange: onFilterChange,
    count: filterCount = 0,
    onClear: onClearFilters,
    search,
    totalCount: filteringTotal,
  } = filtering ?? {};
  const {
    renderRow: renderMobileRow,
    rowSkeleton: mobileRowSkeleton,
    listClassName: mobileListClassName,
  } = mobile ?? {};
  const renderExpandedRow = expand?.render;
  const neighborMotion = {
    activeIndex: useMotionValue(-1),
    activeScope: useMotionValue<string | null>(null),
    x: useMotionValue(0),
  };
  // All mobile cards share this channel; scope prevents motion crossing group headers.
  /* Which layout this list wants is the **panel's** width, not the window's
     (docs/client.md): settings docked narrow beside a terminal is as narrow as
     a phone, and asking `useIsMobile` there drew the full table in a 320px box.
     Measured rather than a container query because this picks a whole tree —
     cards and table are different markup, and only one of them is rendered. */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrow(rootRef);
  const viewport = isNarrow ? "mobile" : "desktop";
  // Each viewport remembers its own table/cards choice (mobile defaults to
  // cards, desktop to table). `viewToggle` lets the user override either.
  const [view, setViewState] = React.useState<"table" | "cards">(() =>
    readView(viewport),
  );
  React.useEffect(() => {
    setViewState(readView(viewport));
  }, [viewport]);
  const setView = (next: "table" | "cards") => {
    localStorage.setItem(VIEW_STORAGE_KEY[viewport], next);
    setViewState(next);
  };
  // A narrow panel always has a list to show (the default row); the toggle is
  // offered once the caller has given the list something of its own.
  const hasCustomCards = Boolean(renderMobileRow || renderFullRow || mark);
  const showCards = viewToggle && hasCustomCards ? view === "cards" : isNarrow;
  const loadStep = pageSize;
  // Measured height of the toolbar row, lent to the bulk bar that replaces it.
  const toolbarHeight = React.useRef(0);
  // Whether the table's scroller has more behind its end — drives the end
  // fade. A ref callback, because the
  // scroller mounts and unmounts with the view, the loading state and the
  // empty state; React 19 runs the returned cleanup.
  const [moreAtEnd, setMoreAtEnd] = React.useState(false);
  const scrollRef = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measure = () => {
      const x = Math.abs(el.scrollLeft); // negative in RTL
      setMoreAtEnd(x + el.clientWidth < el.scrollWidth - 1);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);
  const [internalSorting, setInternalSorting] = React.useState<
    DataTableSort[]
  >([]);
  // Desktop row-detail accordion: one open row at a time, keyed by the table's
  // row id. Keyboard/open-state lives here (uncontrolled) unless the page
  // supplies `expand.rowId` + `onRowIdChange`. Mirrored onto table `expanded`
  // state so each row subscribes to only its own open/closed slice.
  const [internalExpandedRowId, setInternalExpandedRowId] = React.useState<
    string | null
  >(null);
  const expandControlled =
    expand?.rowId !== undefined && !!expand.onRowIdChange;
  const expandedRowId = expandControlled
    ? expand!.rowId!
    : internalExpandedRowId;
  const setExpandedRowId = (next: string | null) =>
    expandControlled
      ? expand!.onRowIdChange!(next)
      : setInternalExpandedRowId(next);
  // Selection lives in table state (controlled from the lifted `Set<string>`).
  // Falling back to an internal set keeps the "ids only" / "neither" combos
  // working exactly as before.
  const [internalSelected, setInternalSelected] = React.useState<Set<string>>(
    new Set(),
  );
  const selectionControlled =
    selectedIdsProp !== undefined && !!onSelectedIdsChange;
  const selected = selectionControlled ? selectedIdsProp! : internalSelected;

  // Mobile group collapse (presentational, NOT table row expansion): groups
  // are expanded by default on mobile; this set tracks the ones the user has
  // collapsed. Kept separate from the desktop `desktopExpandedGroups` set so
  // the two layouts don't fight over each other's default state.
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(
    new Set(),
  );

  // Desktop group collapse (presentational, NOT table row expansion): groups
  // are collapsed by default on desktop. Kept separate from the mobile
  // `collapsedGroups` set above so the two layouts don't fight over each
  // other's default state.
  const [desktopExpandedGroups, setDesktopExpandedGroups] = React.useState<
    Set<string>
  >(new Set());

  const sortingState = manualSorting
    ? sorting
      ? [sorting]
      : []
    : internalSorting;

  // Selection/expansion as table state. These are what each memoized row
  // subscribes to (see rowFlagsSelector): a checkbox tick or expand writes
  // them and re-renders exactly one row.
  const rowSelection = React.useMemo(() => {
    const rec: Record<string, boolean> = {};
    for (const id of selected) rec[id] = true;
    return rec;
  }, [selected]);
  const expansionRecord = React.useMemo(
    () => (expandedRowId ? { [expandedRowId]: true } : {}),
    [expandedRowId],
  );

  // The per-row handlers below are passed into `React.memo` rows, so their
  // identity must be stable or every row re-renders on the first checkbox
  // tick. Reading the current selection/expansion and the page's
  // `onChange`/`onRowIdChange` through refs (updated each render) keeps the
  // callbacks referentially stable without capturing a fresh `rowSelection`
  // (which would change identity on every tick).
  const rowSelectionRef = React.useRef(rowSelection);
  rowSelectionRef.current = rowSelection;
  const expansionRef = React.useRef(expansionRecord);
  expansionRef.current = expansionRecord;
  const onSelectedIdsChangeRef = React.useRef(onSelectedIdsChange);
  onSelectedIdsChangeRef.current = onSelectedIdsChange;
  const selectionControlledRef = React.useRef(selectionControlled);
  selectionControlledRef.current = selectionControlled;
  const setExpandedRowIdRef = React.useRef(setExpandedRowId);
  setExpandedRowIdRef.current = setExpandedRowId;

  const onRowSelectionChange = React.useCallback((updater: unknown) => {
    const prev = rowSelectionRef.current;
    const next =
      typeof updater === "function"
        ? (updater as (old: Record<string, boolean>) => Record<string, boolean>)(
            prev,
          )
        : (updater as Record<string, boolean>);
    const nextSet = new Set<string>();
    for (const k of Object.keys(next)) if (next[k]) nextSet.add(k);
    if (selectionControlledRef.current) {
      onSelectedIdsChangeRef.current!(nextSet);
    } else {
      setInternalSelected(nextSet);
    }
  }, []);

  const onExpandedChange = React.useCallback((updater: unknown) => {
    const prev = expansionRef.current;
    const next =
      typeof updater === "function"
        ? (updater as (old: Record<string, boolean>) => Record<string, boolean>)(
            prev,
          )
        : (updater as Record<string, boolean>);
    const openId = Object.keys(next).find((k) => next[k]) ?? null;
    setExpandedRowIdRef.current(openId);
  }, []);

  // Stable per-row handlers: identity never changes, so `React.memo` on
  // DesktopRow/MobileCard holds across page re-renders (a selection sync
  // re-renders the page, not every row).
  const toggleSelectedRow = React.useCallback(
    (id: string) => {
      onRowSelectionChange((prev: Record<string, boolean>) => {
        const next = { ...prev };
        if (next[id]) delete next[id];
        else next[id] = true;
        return next;
      });
    },
    [onRowSelectionChange],
  );
  const toggleExpandedRow = React.useCallback(
    (id: string) => {
      onExpandedChange((prev: Record<string, boolean>) => {
        const openId = Object.keys(prev).find((k) => prev[k]);
        return openId === id ? {} : { [id]: true };
      });
    },
    [onExpandedChange],
  );

  const table = useAppTable(
    {
      data,
      columns: columns as ColumnDef<TData>[],
      state: {
        sorting: sortingState,
        rowSelection: rowSelection as Record<string, true>,
        expanded: expansionRecord,
      },
      // Not a conditional spread: a `{...} | {}` union here defeats inference
      // and collapses TData to `RowData`. v9 falls back to the row index when
      // this is undefined, which is the same behaviour.
      getRowId: getRowId && ((row: TData, index: number) => getRowId(row, index)),
      onRowSelectionChange,
      onExpandedChange,
      onSortingChange: (updater) => {
        const next =
          typeof updater === "function" ? updater(sortingState) : updater;
        if (manualSorting) {
          onSortingChange?.(next[0] ?? null);
        } else {
          setInternalSorting(next);
        }
      },
      manualSorting,
      // v9 registers features statically, so the paginated row model is always
      // active. An unbounded page size reproduces v8's "no pagination row
      // model" behaviour (every row on one page) — which is what server-side
      // `pagination` wants, since the server already sliced the data.
      initialState: {
        pagination: {
          pageIndex: 0,
          pageSize: pagination ? Number.MAX_SAFE_INTEGER : pageSize,
        },
      },
    },
    // Only the slices that change what this component renders. `sorting` and
    // `pagination` reorder/slice the row model and drive the footer, so they
    // stay. `rowSelection` and `expanded` are deliberately excluded — rows
    // subscribe to those individually, and tracking them here would re-render
    // the entire body on every checkbox tick or expand.
    (s) => ({ sorting: s.sorting, pagination: s.pagination }),
  );

  const helpersFor = React.useCallback((row: Row<TData>) => {
    const c = (id: string) => {
      const cell = row
        .getVisibleCells()
        .find(
          (x) =>
            (x.column.columnDef as { accessorKey?: string }).accessorKey ===
              id || x.column.id === id,
        );
      return cell
        ? flexRender(cell.column.columnDef.cell, cell.getContext())
        : null;
    };
    return {
      cell: c,
      getValue: (id: string) =>
        (row.original as Record<string, unknown> | undefined)?.[id],
      row,
    };
  }, []);

  // Segment the sorted rows into contiguous groups for the mobile layout,
  // mirroring the desktop reducer's contiguous-key detection.
  const mobileGroups = React.useMemo(() => {
    const rows = table.getRowModel().rows;
    const segments: {
      key: string | undefined;
      rows: { row: Row<TData>; index: number }[];
    }[] = [];
    rows.forEach((row, index) => {
      const gk = groupBy ? groupBy(row.original) : undefined;
      const last = segments[segments.length - 1];
      if (last && last.key === gk && gk !== undefined) {
        last.rows.push({ row, index });
      } else {
        segments.push({ key: gk, rows: [{ row, index }] });
      }
    });
    return segments;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.getRowModel().rows, groupBy]);

  const groupedMobile = Boolean(groupBy && renderMobileGroupHeader);

  const hasActions = Boolean(actions && actions.length);
  const hasSelection = Boolean(
    (bulkActions && bulkActions.length) || selectionControlled,
  );
  const hasExpandableRows = Boolean(renderExpandedRow);
  // The column a row is called by: the one that says so, else the first.
  const leafColumns = table.getVisibleLeafColumns();
  const titleColumnId = (
    leafColumns.find((c) => columnMeta(c).title) ?? leafColumns[0]
  )?.id;

  // Actions applicable to a row for a given layout (respects showOn + hidden).
  const actionsFor = React.useCallback(
    (row: TData, layout: "desktop" | "mobile") =>
      (actions ?? [])
        .filter((a) => (a.showOn ?? "both") === "both" || a.showOn === layout)
        .filter((a) => !a.hidden?.(row)),
    [actions],
  );

  // Swipe actions for a mobile card, split onto the left/right rails by each
  // action's `position` (default "right"). Right-rail actions are revealed by
  // swiping the row left; left-rail actions by swiping right.
  const swipeActionsFor = React.useCallback(
    (row: TData) => {
      const toDef = (a: TableAction<TData>) => ({
        label: actionLabel(a, row),
        icon: actionIcon(a, row),
        className: ACTION_TONE_SWIPE_BG[a.tone ?? "neutral"],
        onClick: () => a.onClick(row),
      });
      const applicable = actionsFor(row, "mobile");
      return {
        right: applicable
          .filter((a) => (a.position ?? "right") === "right")
          .map(toDef),
        left: applicable.filter((a) => a.position === "left").map(toDef),
      };
    },
    [actionsFor],
  );

  // Every action a row's "more" menu offers on the narrow list, both rails.
  const menuActionsFor = React.useCallback(
    (row: TData) => actionsFor(row, "mobile"),
    [actionsFor],
  );

  // Desktop Actions column — stable identity so `React.memo` on DesktopRow
  // holds across page re-renders (selection sync re-renders the page, not rows).
  const renderActionsColumn = React.useCallback(
    (row: TData) => {
      const rowActions = actionsFor(row, "desktop");
      if (!rowActions.length) return null;
      const { inline, overflow } = splitActions(rowActions);
      return (
        <div className="flex items-center justify-end gap-1">
          {inline.map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              size="icon-sm"
              title={actionLabel(a, row)}
              aria-label={actionLabel(a, row)}
              disabled={a.disabled?.(row)}
              className={cn(
                "pointer-coarse:size-11",
                REVEAL,
                a.tone && a.tone !== "neutral"
                  ? ACTION_TONE_TEXT[a.tone]
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={(e) => {
                e.stopPropagation();
                a.onClick(row);
              }}
            >
              {actionIcon(a, row)}
            </Button>
          ))}
          {overflow.length > 0 && (
            <ActionMenu
              actions={overflow}
              row={row}
              className={cn("pointer-coarse:size-11", REVEAL)}
            />
          )}
        </div>
      );
    },
    [actionsFor],
  );

  // Untracked read — only ever called from event handlers, which run after render.
  const isAnySelected = React.useCallback(
    () => Object.keys(table.atoms.rowSelection?.get() ?? {}).length > 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table.atoms.rowSelection],
  );


  // The default narrow row, for a caller that gave no `renderRow`: the title
  // column over up to two muted lines, then a status slot (the first
  // end-aligned column) and a chevron when the row goes somewhere. Columns the
  // table hides for width are included — that is what the list is for.
  const renderDefaultMobileRow = React.useCallback(
    (original: TData, { row }: { row: Row<TData> }) => {
      const cells = row.getVisibleCells();
      const titleCell = cells.find((c) => columnMeta(c.column).title) ?? cells[0];
      const statusCell = cells.find(
        (c) => c !== titleCell && columnMeta(c.column).align === "end",
      );
      const lines = cells
        .filter((c) => c !== titleCell && c !== statusCell)
        .slice(0, 2);
      const draw = (c: (typeof cells)[number]) =>
        flexRender(c.column.columnDef.cell, c.getContext());
      return (
        <div className="flex min-w-0 items-center gap-3">
          {mark && (
            // A card (`listClassName`) is a frame, so its tile is concentric
            // with the card's corner; a flat row has no frame to read.
            <div className={cn(MARK_BOX, "size-9", mobileListClassName ? "rounded-inner" : "rounded-lg")}>{mark(original)}</div>
          )}
          <div className="min-w-0 flex-1">
            {titleCell && (
              <div className="truncate text-sm font-medium">{draw(titleCell)}</div>
            )}
            {lines.map((c) => (
              <div key={c.id} className="truncate text-xs text-muted-foreground">
                {draw(c)}
              </div>
            ))}
          </div>
          {statusCell && (
            <div className="shrink-0 text-xs tabular-nums">{draw(statusCell)}</div>
          )}
          {onRowClick && (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
          )}
        </div>
      );
    },
    [mark, onRowClick, mobileListClassName],
  );
  const mobileRowRenderer = renderMobileRow ?? renderDefaultMobileRow;
  // `listClassName` hands the rows' chrome to the caller; otherwise they are
  // flat rows in one continuous list.
  const flatList = !mobileListClassName;

  // Renders a single mobile row (shared by the flat and grouped layouts).
  // `wrapperClassName` only matters for the caller-owned card mode.
  const renderMobileCard = (
    row: Row<TData>,
    rowIndex: number,
    wrapperClassName?: string,
    neighborScope = "flat",
  ) => {
    if (renderFullRow) {
      const full = renderFullRow(row.original, "mobile", rowIndex);
      if (full) return <React.Fragment key={row.id}>{full}</React.Fragment>;
    }
    return (
      <MobileCard
        key={row.id}
        row={row}
        rowIndex={rowIndex}
        wrapperClassName={wrapperClassName}
        flat={flatList}
        Subscribe={table.Subscribe as RowSubscribe}
        renderMobileRow={mobileRowRenderer}
        helpersFor={helpersFor}
        swipeActionsFor={swipeActionsFor}
        menuActionsFor={menuActionsFor}
        hasSelection={hasSelection}
        isAnySelected={isAnySelected}
        onRowClick={onRowClick}
        onToggleSelected={toggleSelectedRow}
        rowClassName={rowClassName}
        neighborMotion={neighborMotion}
        neighborIndex={rowIndex}
        neighborScope={neighborScope}
      />
    );
  };

  // Total columns spanned by full-width rows (group headers, empty state),
  // accounting for the injected selection + actions columns on desktop.
  const totalColSpan =
    columns.length + (hasSelection ? 1 : 0) + (hasActions ? 1 : 0);

  // Mobile strip label for a footer cell — the matching column's string header,
  // falling back to the column id when the header is a render function.
  const footerLabel = (columnId: string) => {
    const header = table
      .getHeaderGroups()[0]
      .headers.find((h) => h.column.id === columnId)?.column.columnDef.header;
    return typeof header === "string" ? header : columnId;
  };

  // Rows-per-page lives in the footer, and only where there is room to use it.
  // A page can opt out (`hidePageSize`) when it renders the control itself
  // (e.g. inline in <PageToolbar>).
  const pageSizeNode =
    hidePageSize || isNarrow
      ? null
      : pagination
        ? pagination.onLimitChange
          ? <RowsPerPageSelect value={pagination.limit ?? PAGE_SIZE_OPTIONS[0]} onChange={pagination.onLimitChange} align="end" />
          : null
        : pageSize
          ? <RowsPerPageSelect value={table.state.pagination.pageSize} onChange={(size) => table.setPageSize(size)} align="end" />
          : null;

  const toolbarActionsNode = toolbarActions?.length ? (
    <HeaderActionOverflow
      items={toolbarActions.map(({ id, showLabel: _showLabel, ...action }) => ({ key: id, ...action }))}
      withLabel={toolbarActions.some((action) => action.showLabel)}
      responsive
    />
  ) : null;

  const canToggleView = viewToggle && hasCustomCards;
  const viewToggleNode = canToggleView ? (
    <div
      role="group"
      aria-label="Layout"
      className="flex shrink-0 items-center rounded-4xl bg-muted p-[3px]"
    >
      {(
        [
          ["table", "Table view", Table2],
          ["cards", "List view", List],
        ] as const
      ).map(([value, label, Icon]) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={view === value}
          onClick={() => setView(value)}
          className={cn(
            "flex size-7.5 items-center justify-center rounded-4xl border border-transparent text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:size-10",
            view === value && "bg-background text-foreground dark:border-input dark:bg-input/30",
          )}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  ) : null;

  // "12 of 40" — only while the list is narrowed by a search or a filter, and
  // only when the caller can say what "of" is.
  const narrowed = Boolean(search?.value.trim()) || filterCount > 0;
  const resultCountNode =
    narrowed && filteringTotal !== undefined && !pagination ? (
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {`${data.length} of ${filteringTotal}`}
      </span>
    ) : null;

  const trailingNode =
    resultCountNode || toolbarActionsNode || toolbarSlot || viewToggleNode ? (
      <div className="flex items-center justify-end gap-2">
        {resultCountNode}
        {toolbarActionsNode}
        {toolbarSlot}
        {viewToggleNode}
      </div>
    ) : null;

  const hasFilterBar = Boolean(
    search || (filters && filters.length > 0) || trailingNode,
  );

  const bulkButtons = (liveSelected: TData[], narrow: boolean) =>
    (bulkActions ?? [])
      .filter((a) => !a.hidden?.(liveSelected))
      .map((a) => (
        <Button
          key={a.id}
          size={narrow ? "default" : "sm"}
          variant={
            a.tone === "danger"
              ? "destructive"
              : a.tone === "neutral"
                ? "outline"
                : "default"
          }
          disabled={a.disabled?.(liveSelected)}
          onClick={() => a.onClick(liveSelected)}
          className={cn("gap-1.5", narrow && "min-w-28 flex-1 shrink-0 pointer-coarse:h-11")}
        >
          {a.icon}
          {a.label}
        </Button>
      ));

  // The toolbar row — or, while rows are selected, the bulk bar *in its place*
  // at the same height, so ticking a box moves nothing below it. Subscribed to
  // the rowSelection atom so it tracks the live selection without the body
  // re-subscribing on every tick. `renderToolbar` replaces the bar entirely.
  const selectionUi = hasSelection && Boolean(renderSelectionToolbar || bulkActions?.length);
  const filtersNode = (
    <FiltersBar
      search={search}
      fields={filters}
      values={filterValues}
      onFilterChange={onFilterChange!}
      filterCount={filterCount}
      onClearFilters={onClearFilters}
      trailing={trailingNode ?? undefined}
      narrow={isNarrow}
    />
  );
  const toolbarNode =
    hasFilterBar || selectionUi ? (
      <table.Subscribe source={table.atoms.rowSelection}>
        {(selectionRecord) => {
          const selectedCount = Object.keys(selectionRecord ?? {}).length;
          if (!selectionUi || selectedCount === 0) {
            return hasFilterBar ? (
              <div
                ref={(node) => {
                  // Remembered for the bulk bar, which takes this row's height.
                  if (node) toolbarHeight.current = node.offsetHeight;
                }}
                className={cn("border-b", isNarrow ? "p-3" : "px-4 py-3")}
              >
                {filtersNode}
              </div>
            ) : null;
          }
          const liveSelected = table
            .getSelectedRowModel()
            .rows.map((r) => r.original);
          if (renderSelectionToolbar) {
            return (
              <div className="border-b">
                {renderSelectionToolbar(liveSelected, () => table.resetRowSelection())}
              </div>
            );
          }
          const allSelected = table.getIsAllPageRowsSelected();
          const buttons = bulkButtons(liveSelected, false);
          return (
            <>
              <div
                className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-primary/5 px-4 py-2"
                style={{ minHeight: toolbarHeight.current || undefined }}
              >
                <span className="flex size-4 items-center justify-center pointer-coarse:size-11">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={!allSelected && table.getIsSomePageRowsSelected()}
                    onCheckedChange={() => table.toggleAllPageRowsSelected()}
                    aria-label="Select all rows"
                    className="size-4"
                  />
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {`${selectedCount} selected`}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => table.resetRowSelection()}
                  className="pointer-coarse:h-11 pointer-coarse:px-3"
                >
                  {"Clear"}
                </Button>
                {selectionTotalCount !== undefined &&
                  onSelectAllMatching &&
                  !allSelected &&
                  selectionTotalCount > selectedCount && (
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      onClick={onSelectAllMatching}
                      className="h-auto px-0 pointer-coarse:min-h-11"
                    >
                      {`Select all ${selectionTotalCount}`}
                    </Button>
                  )}
                {!isNarrow && (
                  <div className="ms-auto flex items-center gap-2">{buttons}</div>
                )}
              </div>
            </>
          );
        }}
      </table.Subscribe>
    ) : null;

  // The phone's bulk actions: a bar fixed above the home indicator and the soft
  // keyboard (`KEYBOARD_RISE` is its `bottom`), never under either. It is out of
  // flow, so an in-flow spacer of its height keeps the last row and the pager
  // reachable while it is up.
  const bulkBarNode =
    isNarrow && selectionUi && !renderSelectionToolbar ? (
      <table.Subscribe source={table.atoms.rowSelection}>
        {(selectionRecord) => {
          if (Object.keys(selectionRecord ?? {}).length === 0) return null;
          const buttons = bulkButtons(
            table.getSelectedRowModel().rows.map((r) => r.original),
            true,
          );
          if (!buttons.length) return null;
          return (
            <>
              <div
                aria-hidden
                className="h-[calc(3.5rem+max(0.5rem,var(--safe-bottom)))]"
              />
              <div
                role="toolbar"
                aria-label="Bulk actions"
                className={cn(
                  "fixed inset-x-0 z-50 border-t bg-background px-3 pt-2 pb-[max(0.5rem,var(--safe-bottom))]",
                  KEYBOARD_RISE,
                )}
              >
                <div className="flex gap-2 overflow-x-auto">{buttons}</div>
              </div>
            </>
          );
        }}
      </table.Subscribe>
    ) : null;

  // The surface's foot: where you are in the data. Silent when everything is
  // on one page and there is no page size to change.
  const total = pagination
    ? (selectionTotalCount ?? data.length)
    : data.length;
  const pageIdx = table.state.pagination.pageIndex;
  const size = table.state.pagination.pageSize;
  const pageCount = pagination ? pagination.totalPages : table.getPageCount();
  const currentPage = pagination ? pagination.page : pageIdx + 1;
  const canPrev = pagination
    ? (pagination.hasPrev ?? pagination.page > 1)
    : table.getCanPreviousPage();
  const canNext = pagination
    ? (pagination.hasNext ?? pagination.page < pagination.totalPages)
    : table.getCanNextPage();
  const goPrev = () =>
    pagination ? pagination.onPageChange(pagination.page - 1) : table.previousPage();
  const goNext = () =>
    pagination ? pagination.onPageChange(pagination.page + 1) : table.nextPage();
  const pageLimit = pagination ? pagination.limit : size;
  const rangeLabel =
    pagination && !(pageLimit && selectionTotalCount !== undefined)
      ? `Page ${currentPage} of ${pageCount}`
      : pageLimit
        ? `${Math.min((currentPage - 1) * pageLimit + 1, total)}-${Math.min(currentPage * pageLimit, total)} of ${total}`
        : `${total} rows`;
  const showFooter =
    !isLoading &&
    total > 0 &&
    (pageCount > 1 ||
      (pageSizeNode !== null && total > PAGE_SIZE_OPTIONS[0]));
  const footerNode = !showFooter ? null : isNarrow ? (
    // A thumb-sized "Load more" for a client-paged list (the rows stay one
    // continuous list); prev/next when the server owns the pages.
    <div className="flex flex-col items-stretch gap-2 border-t bg-muted/50 p-3">
      <span className="text-center text-xs tabular-nums text-muted-foreground">
        {pagination
          ? rangeLabel
          : `Showing ${Math.min(size, total)} of ${total}`}
      </span>
      {pagination ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="pointer-coarse:h-11" disabled={!canPrev} onClick={goPrev}>
            <ChevronLeft className="size-4 rtl:rotate-180" />
            {"Previous"}
          </Button>
          <Button variant="outline" className="pointer-coarse:h-11" disabled={!canNext} onClick={goNext}>
            {"Next"}
            <ChevronRight className="size-4 rtl:rotate-180" />
          </Button>
        </div>
      ) : (
        canNext && (
          <Button
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => {
              table.setPageIndex(0);
              table.setPageSize(size + loadStep);
            }}
          >
            {"Load more"}
          </Button>
        )
      )}
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/50 px-4 py-2">
      <span className="text-xs tabular-nums text-muted-foreground">{rangeLabel}</span>
      <div className="flex items-center gap-2">
        {pageSizeNode}
        {pageCount > 1 && (
          <>
            <span className="text-xs tabular-nums text-muted-foreground">
              {`${currentPage} / ${pageCount}`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                title="Previous page"
                aria-label="Previous page"
                className="pointer-coarse:size-11"
                disabled={!canPrev}
                onClick={goPrev}
              >
                <ChevronLeft className="size-4 rtl:rotate-180" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                title="Next page"
                aria-label="Next page"
                className="pointer-coarse:size-11"
                disabled={!canNext}
                onClick={goNext}
              >
                <ChevronRight className="size-4 rtl:rotate-180" />
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  /* A search or a filter that matched nothing is a different sentence from a
     list with no rows, and it carries the way back out of it. */
  const searchQuery = search?.value.trim() ?? "";
  const emptyNode = (
    <DataTableEmpty
      message={
        emptyMessage ??
        (narrowed
          ? searchQuery
            ? `Nothing matches “${searchQuery}”.`
            : "Nothing matches these filters."
          : undefined)
      }
      icon={emptyIcon}
      action={
        emptyAction ??
        (narrowed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              search?.onChange("");
              onClearFilters?.();
            }}
          >
            {"Clear filters"}
          </Button>
        ) : undefined)
      }
    />
  );
  const rows = table.getRowModel().rows;

  // ── Desktop table ──
  const headCell = (
    h: ReturnType<typeof table.getHeaderGroups>[number]["headers"][number],
    index: number,
  ) => {
    const meta = columnMeta(h.column);
    const isTitle = h.column.id === titleColumnId;
    const leadPad = index === 0 && !hasSelection;
    const canSort = h.column.getCanSort();
    const sorted = h.column.getIsSorted();
    // A plain header on a sortable column becomes the whole cell's button. A
    // function header (`SortableHeader`) already draws its own — left alone.
    const nativeSort =
      canSort && !h.isPlaceholder && typeof h.column.columnDef.header !== "function";
    return (
      <TableHead
        key={h.id}
        aria-sort={
          canSort
            ? sorted === "asc"
              ? "ascending"
              : sorted === "desc"
                ? "descending"
                : "none"
            : undefined
        }
        className={cn(
          "group/head sticky top-0 z-10 h-10 px-3 text-start text-sm font-medium whitespace-nowrap text-foreground",
          HEAD_BG,
          leadPad && "ps-4",
          nativeSort && "p-0",
          meta.align === "end" && "text-end",
          meta.className,
        )}
      >
        {h.isPlaceholder ? null : nativeSort ? (
          <button
            type="button"
            onClick={() => h.column.toggleSorting(sorted === "asc")}
            className={cn(
              "flex h-10 w-full items-center gap-1 px-3 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
              leadPad && "ps-4",
              meta.align === "end" && "justify-end",
              sorted && "text-foreground",
            )}
          >
            {flexRender(h.column.columnDef.header, h.getContext())}
            <SortGlyph sorted={sorted} />
          </button>
        ) : (
          flexRender(h.column.columnDef.header, h.getContext())
        )}
      </TableHead>
    );
  };

  const tableView = (
    <div className="relative">
      {/* This is the surface's one scroller (`maxHeight` gives the sticky
          header something to stick to). Overflow scrolls in here, never the
          page: the end fade says there is more to the side. */}
      <div
        ref={scrollRef}
        className="group/scroll overflow-auto"
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        <table data-slot="table" className="w-max min-w-full caption-bottom text-sm">
          <TableHeader className="[&_tr]:border-b-0">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hasSelection && (
                  <TableHead
                    className={cn(
                      "sticky top-0 z-10 h-10 w-12 ps-4 pe-0",
                      HEAD_BG,
                    )}
                  >
                    <table.Subscribe source={table.atoms.rowSelection}>
                      {() => {
                        const all = table.getIsAllPageRowsSelected();
                        const some = table.getIsSomePageRowsSelected();
                        return (
                          <Checkbox
                            checked={all}
                            indeterminate={!all && some}
                            onCheckedChange={() => table.toggleAllPageRowsSelected()}
                            aria-label={"Select all rows"}
                            className="size-4"
                          />
                        );
                      }}
                    </table.Subscribe>
                  </TableHead>
                )}
                {hg.headers.map(headCell)}
                {hasActions && (
                  <TableHead className={cn("sticky top-0 z-10 h-10 w-px px-3", HEAD_BG)}>
                    <span className="sr-only">{"Actions"}</span>
                  </TableHead>
                )}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: skeletonRows }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="h-14 hover:bg-transparent">
                  {hasSelection && (
                    <TableCell className="w-12 ps-4 pe-0">
                      <Skeleton className="size-4 rounded" />
                    </TableCell>
                  )}
                  {columns.map((_col, j) => (
                    <TableCell key={j} className="px-3 py-3">
                      {j === 0 && mark ? (
                        <div className="flex items-center gap-3">
                          <Skeleton className="size-9 shrink-0 rounded-lg" />
                          <Skeleton className="h-4 w-full max-w-40" />
                        </div>
                      ) : (
                        <Skeleton className={cn("h-4 w-full", j === 0 ? "max-w-48" : "max-w-24")} />
                      )}
                    </TableCell>
                  ))}
                  {hasActions && (
                    <TableCell className="w-px">
                      <Skeleton className="size-8 rounded-lg" />
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.reduce<React.ReactNode[]>(
                (acc, row, index) => {
                  if (groupBy && renderGroupHeader) {
                    const gk = groupBy(row.original);
                    if (
                      gk &&
                      (index === 0 ||
                        groupBy(rows[index - 1].original) !== gk)
                    ) {
                      const isExpanded = desktopExpandedGroups.has(gk);
                      const onToggle = () =>
                        setDesktopExpandedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(gk)) next.delete(gk);
                          else next.add(gk);
                          return next;
                        });
                      const content = renderGroupHeader(
                        gk,
                        row.original,
                        isExpanded,
                        onToggle,
                      );
                      if (content) {
                        acc.push(
                          <TableRow
                            key={`group-${gk}`}
                            className="bg-muted/50 hover:bg-muted/50"
                          >
                            <TableCell colSpan={totalColSpan}>
                              {content}
                            </TableCell>
                          </TableRow>,
                        );
                      }
                    }
                  }
                  const full = renderFullRow?.(row.original, "desktop", index);
                  if (full) {
                    acc.push(
                      <React.Fragment key={row.id}>{full}</React.Fragment>,
                    );
                    return acc;
                  }
                  acc.push(
                    <DesktopRow
                      key={row.id}
                      row={row}
                      index={index}
                      Subscribe={table.Subscribe as RowSubscribe}
                      hasSelection={hasSelection}
                      hasExpandableRows={hasExpandableRows}
                      hasActions={hasActions}
                      expandColSpan={totalColSpan}
                      titleColumnId={titleColumnId}
                      mark={mark}
                      onRowClick={onRowClick}
                      onToggleExpanded={toggleExpandedRow}
                      onToggleSelected={toggleSelectedRow}
                      rowClassName={rowClassName}
                      renderExpandedRow={
                        expandedRowId === row.id
                          ? renderExpandedRow
                          : undefined
                      }
                      expandLoading={
                        expandedRowId === row.id
                          ? expand?.loading
                          : undefined
                      }
                      renderActionsColumn={renderActionsColumn}
                    />,
                  );
                  return acc;
                },
                [],
              )
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={totalColSpan} className="p-0">
                  {emptyNode}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {footer && rows.length > 0 && (
            <TableFooter className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                {hasSelection && <TableCell className="w-12 ps-4" />}
                {table.getHeaderGroups()[0].headers.map((header) => {
                  const cell = footer.cells.find(
                    (c) => c.columnId === header.column.id,
                  );
                  const isEnd =
                    cell?.align === "end" || columnMeta(header.column).align === "end";
                  return (
                    <TableCell
                      key={header.column.id}
                      className={cn(
                        "px-3",
                        isEnd && "text-end tabular-nums",
                        columnMeta(header.column).className,
                      )}
                    >
                      {cell
                        ? cell.loading
                          ? <Skeleton className="h-4 w-16" />
                          : cell.render()
                        : " "}
                    </TableCell>
                  );
                })}
                {hasActions && <TableCell className="text-end" />}
              </TableRow>
            </TableFooter>
          )}
        </table>
      </div>
      {/* End-edge fade: more columns off-screen. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 end-0 z-30 w-8 bg-linear-to-l from-card to-transparent transition-opacity rtl:bg-linear-to-r",
          moreAtEnd ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );

  // ── Narrow list ──
  const mobileFooterStrip =
    footer && footer.cells.length > 0 ? (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t bg-muted/50 px-4 py-3 text-sm font-medium">
        {footer.label && (
          <span className="text-xs text-muted-foreground">
            {footer.label}
          </span>
        )}
        {footer.cells.map((c) => (
          <span key={c.columnId} className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">
              {footerLabel(c.columnId)}
            </span>
            {c.loading ? <Skeleton className="h-4 w-16" /> : c.render()}
          </span>
        ))}
      </div>
    ) : null;

  const listView = isLoading ? (
    <div className={flatList ? "divide-y" : "space-y-2 p-3"}>
      {Array.from({ length: skeletonRows }).map((_, i) => (
        <React.Fragment key={`sk-${i}`}>
          {mobileRowSkeleton ?? (
            <MobileRowSkeleton
              withMark={Boolean(mark)}
              withSelect={flatList && hasSelection}
              withMenu={flatList && hasActions}
              className={flatList ? undefined : "rounded-2xl bg-card ring-1 ring-foreground/10"}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  ) : rows.length ? (
    groupedMobile ? (
      <>
      <div className="divide-y">
        {mobileGroups.map((seg) => {
          const gk = seg.key;
          const isExpanded =
            gk === undefined ? true : !collapsedGroups.has(gk);
          const onToggle = () =>
            setCollapsedGroups((prev) => {
              if (gk === undefined) return prev;
              const next = new Set(prev);
              if (next.has(gk)) next.delete(gk);
              else next.add(gk);
              return next;
            });
          const header =
            gk !== undefined && renderMobileGroupHeader
              ? renderMobileGroupHeader(
                  gk,
                  seg.rows[0].row.original,
                  isExpanded,
                  onToggle,
                )
              : null;

          // A real group: a tinted header strip over its member rows, all in
          // the one list. Singletons are just rows.
          if (header) {
            return (
              <div key={`group-${gk}`}>
                <div className="border-b bg-muted/50 px-4 py-3">
                  {header}
                </div>
                <div className="divide-y">
                  {seg.rows.map(({ row, index }) =>
                    renderMobileCard(row, index, undefined, `group-${gk}`),
                  )}
                </div>
              </div>
            );
          }
          return seg.rows.map(({ row, index }) =>
            renderMobileCard(row, index, undefined, `singleton-${index}`),
          );
        })}
      </div>
      {mobileFooterStrip}
      </>
    ) : mobileListClassName ? (
      <>
        <div className={cn("p-3", mobileListClassName)}>
          {rows.map((row, rowIndex) => renderMobileCard(row, rowIndex))}
        </div>
        {mobileFooterStrip}
      </>
    ) : (
      <>
        <div className="divide-y">
          {rows.map((row, rowIndex) => renderMobileCard(row, rowIndex))}
        </div>
        {mobileFooterStrip}
      </>
    )
  ) : (
    emptyNode
  );

  return (
    <div ref={rootRef} className={cn("w-full", className)}>
      {/* One surface: toolbar, rows, footer. Nothing floats beside it. */}
      <div className="flex flex-col overflow-hidden rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/10">
        {toolbarNode}
        {showCards ? listView : tableView}
        {footerNode}
      </div>
      {bulkBarNode}
    </div>
  );
}

/** "Nothing here", inside the surface: the page `Empty`'s icon tile and type
 *  without its dashed edge (the table is already the frame), so the two read
 *  as one family. A non-string message is the caller's own markup. */
export function DataTableEmpty({
  message,
  icon,
  action,
}: {
  message?: React.ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="min-h-56 flex-none gap-3">
      <EmptyMedia variant="icon" className="mb-0">
        {icon ?? <Inbox />}
      </EmptyMedia>
      {typeof message === "string" || !message ? (
        <EmptyDescription className="text-pretty">{message ?? "No results."}</EmptyDescription>
      ) : (
        message
      )}
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** Sort direction mark: a ghost chevron on hover, a solid arrow once active. */
function SortGlyph({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp className="size-3 shrink-0" />;
  if (sorted === "desc") return <ArrowDown className="size-3 shrink-0" />;
  return (
    <ChevronsUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover/head:opacity-60 group-focus-within/head:opacity-60 pointer-coarse:opacity-40" />
  );
}

/** Default loading placeholder for one narrow row: [mark] title + meta line on
 *  the start side, a badge on the end — the shape the default row has.
 *  Override per page via `mobile.rowSkeleton` when the real row differs. */
export function MobileRowSkeleton({
  className,
  withMark,
  withSelect,
  withMenu,
}: {
  className?: string;
  withMark?: boolean;
  /** Leave room for the leading checkbox of a selectable list. */
  withSelect?: boolean;
  /** Leave room for the trailing "more" button. */
  withMenu?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center gap-3 px-4 py-3",
        className,
      )}
    >
      {withSelect && <Skeleton className="size-4 shrink-0 rounded" />}
      {withMark && <Skeleton className="size-9 shrink-0 rounded-lg" />}
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-5 w-14 shrink-0 rounded-full" />
      {withMenu && <Skeleton className="size-4 shrink-0 rounded" />}
    </div>
  );
}

/** Placeholder for a server-loaded expanded row (`expand.loading`). */
function ExpandedRowSkeleton() {
  return (
    <div className="space-y-2 py-1">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-1/4" />
    </div>
  );
}

/** Sortable column header — use as a column `header` when the header needs
 *  more than plain text. A plain-text header on a sortable column is already
 *  the whole cell's button, with no help from this. */
export function SortableHeader({
  column,
  children,
}: {
  column: {
    toggleSorting: (desc?: boolean) => void;
    getIsSorted: () => false | "asc" | "desc";
  };
  children: React.ReactNode;
}) {
  const sorted = column.getIsSorted();
  return (
    <button
      type="button"
      className={cn(
        "-ms-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
        sorted && "text-foreground",
      )}
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {children}
      <SortGlyph sorted={sorted} />
    </button>
  );
}

/** Rows-per-page selector — exported so pages can place it next to their
 *  filter controls (e.g. inside <PageToolbar>) instead of the table footer. */
export function RowsPerPageSelect({
  value,
  onChange,
  align = "start",
  className,
}: {
  value: number;
  onChange: (size: number) => void;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button
          variant="outline"
          size="sm"
          className={cn("gap-1.5", className)} />}>
          <Rows3 className="size-3.5 opacity-60" />
          {`${value} rows`}
          <ChevronDown className="size-3.5 opacity-60" />
        
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={MENU_WIDTH}>
        {PAGE_SIZE_OPTIONS.map((size) => (
          <DropdownMenuItem
            key={size}
            className={cn(size === value && "bg-accent")}
            onClick={() => onChange(size)}
          >
            {size}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
