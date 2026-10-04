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
}

const columnMeta = (column: { columnDef: { meta?: unknown } }) =>
  (column.columnDef.meta ?? {}) as DataTableColumnMeta;
import {
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Inbox,
  Rows3,
  MoreHorizontal,
  LayoutGrid,
  Table2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SwipeableRow } from "@/components/swipeable-row";
import type { SwipeNeighborMotion } from "@/components/motion/swipeable-list";
import { useMotionValue } from "motion/react";
import { HeaderActionOverflow } from "@/components/ui/action-overflow";
import { BulkActionBar } from "@/components/bulk-action-bar";
import { PaginationControls } from "@/components/pagination-controls";
import { useIsNarrow } from "@/hooks/use-device";
import {
  FiltersBar,
  type FilterFieldDef,
  type FilterSchemaValue,
} from "@/components/ui/filters-bar";

export interface TableAction<TData> {
  id: string;
  label: string;
  icon: ReactNode;
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
  onRowClick,
  onToggleExpanded,
  onToggleSelected,
  rowClassName,
  renderExpandedRow,
  expandLoading,
  renderActionsColumn,
}: DesktopRowProps<TData>) {
  return (
    <Subscribe selector={rowFlagsSelector(row.id)}>
      {({ sel, exp }) => (
        <>
          <TableRow
            data-state={sel ? "selected" : undefined}
            aria-expanded={hasExpandableRows ? exp : undefined}
            onClick={() => {
              if (hasExpandableRows) onToggleExpanded(row.id);
              else onRowClick?.(row.original);
            }}
            className={cn(
              (onRowClick || hasExpandableRows) && "cursor-pointer",
              rowClassName?.(row.original, index),
            )}
          >
            {hasSelection && (
              <TableCell
                className="w-12 ps-4"
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={sel}
                  onCheckedChange={() => onToggleSelected(row.id)}
                  aria-label="Select row"
                  className="h-4 w-4"
                />
              </TableCell>
            )}
            {row.getVisibleCells().map((cell) => (
              <TableCell
                key={cell.id}
                className={cn(
                  "px-3 py-3",
                  columnMeta(cell.column).align === "end" && "text-end",
                  columnMeta(cell.column).className,
                )}
              >
                {flexRender(
                  cell.column.columnDef.cell,
                  cell.getContext(),
                )}
              </TableCell>
            ))}
            {hasActions && (
              <TableCell
                className="text-end"
                onClick={(e) => e.stopPropagation()}
              >
                {renderActionsColumn(row.original)}
              </TableCell>
            )}
          </TableRow>
          {/* Only built when open — previously `render` ran for every collapsed
              row on every render. */}
          {exp && hasExpandableRows && (
            <TableRow
              className="bg-muted/20 hover:bg-muted/20 border-b-0"
            >
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
 * One mobile card. The `Subscribe` boundary wraps the whole `SwipeableRow`,
 * so the swipe rail's Select/Deselect state and the tap-to-select behavior
 * both track this row's selected flag alone.
 */
interface MobileCardProps<TData extends RowData> {
  row: Row<TData>;
  rowIndex: number;
  wrapperClassName?: string;
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
  hasSelection: boolean;
  isAnySelected: () => boolean;
  onRowClick?: (row: TData) => void;
  onToggleSelected: (rowId: string) => void;
  rowClassName?: (row: TData, index: number) => string | undefined;
  neighborMotion: SwipeNeighborMotion;
  neighborIndex: number;
  neighborScope: string;
}

/* Generic-through-memo, as DesktopRow above. */
const MobileCard = React.memo(function MobileCard<TData extends RowData>({
  row,
  rowIndex,
  wrapperClassName,
  Subscribe,
  renderMobileRow,
  helpersFor,
  swipeActionsFor,
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
  const tappable = Boolean(onRowClick);

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
              "flex items-center gap-3 w-full min-w-0",
              sel && "opacity-80",
            )}
          >
            <div
              className="flex-1 min-w-0"
              onClick={(e) => {
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
            >
              {content}
            </div>
          </div>
        );

        const card = (
          <div
            className={cn(
              wrapperClassName ??
                "flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3.5 shadow-sm shadow-black/[0.03]",
              tappable && "cursor-pointer active:bg-muted/60 transition-colors",
              sel && "ring-2 ring-primary ring-inset rounded-2xl",
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
  const showCards = viewToggle ? view === "cards" : isNarrow;
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
        label: a.label,
        icon: a.icon,
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

  // Desktop Actions column — stable identity so `React.memo` on DesktopRow
  // holds across page re-renders (selection sync re-renders the page, not rows).
  const renderActionsColumn = React.useCallback(
    (row: TData) => {
      const rowActions = actionsFor(row, "desktop");
      if (!rowActions.length) return null;

      const maxInline = 3;
      const inline = rowActions.slice(0, maxInline);
      const overflow = rowActions.slice(maxInline);

      return (
        <div className="flex items-center justify-end gap-0.5">
          {inline.map((a) => (
            <Tooltip key={a.id}>
              <TooltipTrigger
                render={<Button
                  variant="ghost"
                  size="icon"
                  disabled={a.disabled?.(row)}
                  className={cn(
                    "h-8 w-8 rounded-lg",
                    ACTION_TONE_TEXT[a.tone ?? "neutral"],
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    a.onClick(row);
                  }} />}>
                  {a.icon}
                
              </TooltipTrigger>
              <TooltipContent>{a.label}</TooltipContent>
            </Tooltip>
          ))}
          {overflow.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={"More actions"} />}>
                  <MoreHorizontal className="h-4 w-4" />
                
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {overflow.map((a) => (
                  <DropdownMenuItem
                    key={a.id}
                    disabled={a.disabled?.(row)}
                    onClick={(e) => {
                      e.stopPropagation();
                      a.onClick(row);
                    }}
                    className={cn("gap-2", ACTION_TONE_TEXT[a.tone ?? "neutral"])}
                  >
                    {a.icon}
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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

  // Renders a single mobile card (shared by the flat and grouped layouts).
  // `wrapperClassName` overrides the default flat list-row chrome — grouped
  // members pass a nested-card style instead.
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
    if (!renderMobileRow) return null;
    return (
      <MobileCard
        key={row.id}
        row={row}
        rowIndex={rowIndex}
        wrapperClassName={wrapperClassName}
        Subscribe={table.Subscribe as RowSubscribe}
        renderMobileRow={renderMobileRow}
        helpersFor={helpersFor}
        swipeActionsFor={swipeActionsFor}
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

  // Rendered next to the filters (toolbar), not in the pagination footer.
  // A page can opt out (`hidePageSize`) when it renders the control itself
  // (e.g. inline in <PageToolbar>).
  const pageSizeNode = hidePageSize
    ? null
    : pagination
      ? pagination.onLimitChange
        ? <RowsPerPageSelect value={pagination.limit ?? PAGE_SIZE_OPTIONS[0]} onChange={pagination.onLimitChange} />
        : null
      : pageSize
        ? <RowsPerPageSelect value={table.state.pagination.pageSize} onChange={(size) => table.setPageSize(size)} />
        : null;

  const paginationNode = pagination ? (
    <PaginationControls
      page={pagination.page}
      totalPages={pagination.totalPages}
      hasPrev={pagination.hasPrev}
      hasNext={pagination.hasNext}
      onPageChange={pagination.onPageChange}
    />
  ) : null;

  const toolbarActionsNode = toolbarActions?.length ? (
    <HeaderActionOverflow
      items={toolbarActions.map(({ id, showLabel: _showLabel, ...action }) => ({ key: id, ...action }))}
      withLabel={toolbarActions.some((action) => action.showLabel)}
      responsive
    />
  ) : null;

  const canToggleView = viewToggle && Boolean(renderMobileRow || renderFullRow);
  const viewToggleNode = canToggleView ? (
    <div className="flex items-center rounded-md border p-0.5">
      <Button
        variant={view === "table" ? "secondary" : "ghost"}
        size="icon"
        className="h-7 w-7 rounded-sm"
        aria-label={"Table view"}
        onClick={() => setView("table")}
      >
        <Table2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant={view === "cards" ? "secondary" : "ghost"}
        size="icon"
        className="h-7 w-7 rounded-sm"
        aria-label={"Card view"}
        onClick={() => setView("cards")}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </Button>
    </div>
  ) : null;

  const trailingNode =
    pageSizeNode || toolbarActionsNode || viewToggleNode ? (
      <div className="flex items-center gap-2">
        {pageSizeNode}
        {toolbarActionsNode}
        {viewToggleNode}
      </div>
    ) : null;

  const hasFilterBar = Boolean(
    search || (filters && filters.length > 0) || trailingNode,
  );

  // Bulk selection toolbar — the shared <BulkActionBar> (inline on desktop,
  // fixed bottom bar on mobile). `renderToolbar` replaces it entirely.
  // Subscribed to the rowSelection atom so it tracks the live selection without
  // the body re-subscribing on every tick.
  const selectionToolbar = hasSelection ? (
    <table.Subscribe source={table.atoms.rowSelection}>
      {(selectionRecord) => {
        const selectedCount = Object.keys(selectionRecord ?? {}).length;
        const liveSelected = table
          .getSelectedRowModel()
          .rows.map((r) => r.original);
        const allSelected = table.getIsAllPageRowsSelected()
          ? true
          : table.getIsSomePageRowsSelected()
            ? "indeterminate"
            : false;
        if (renderSelectionToolbar) {
          return renderSelectionToolbar(
            liveSelected,
            () => table.resetRowSelection(),
          );
        }
        if (!bulkActions?.length) return null;
        return (
          <BulkActionBar
            selectedCount={selectedCount}
            isAllSelected={allSelected === true}
            onToggleAll={() => table.toggleAllPageRowsSelected()}
            onClear={() => table.resetRowSelection()}
            totalCount={selectionTotalCount}
            onSelectAllMatching={onSelectAllMatching}
            actions={bulkActions
              .filter((a) => !a.hidden?.(liveSelected))
              .map((a) => ({
                label: a.label,
                icon: a.icon,
                disabled: a.disabled?.(liveSelected),
                variant:
                  a.tone === "danger"
                    ? ("destructive" as const)
                    : a.tone === "neutral"
                      ? ("outline" as const)
                      : ("default" as const),
                onClick: () => a.onClick(liveSelected),
              }))}
          />
        );
      }}
    </table.Subscribe>
  ) : null;

  return (
    <div ref={rootRef} className={cn("w-full space-y-4", className)}>
      {/* Search + filters + rows-per-page — owned by the table. */}
      {hasFilterBar && (
        <FiltersBar
          search={search}
          fields={filters}
          values={filterValues}
          onFilterChange={onFilterChange!}
          filterCount={filterCount}
          onClearFilters={onClearFilters}
          trailing={trailingNode ?? undefined}
        />
      )}

      {/* Bulk selection toolbar (desktop + mobile) */}
      {selectionToolbar}

      {/* DESKTOP TABLE — skipped entirely when cards are showing (mobile
          viewport, or desktop opted into cards via `viewToggle`), so
          navigations don't pay for a hidden second tree. */}
      {!(showCards && (renderMobileRow || renderFullRow)) && (
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm shadow-black/[0.03]">
        {/* `Table` renders its own `overflow-x-auto` container, so there is no
            wrapper here: two nested scrollers meant a swipe scrolled whichever
            one the browser picked, and only one of them could be told about the
            back-gesture. w-max lets columns take their natural width and
            overflow into that container instead of being squeezed to fit;
            min-w-full keeps narrow tables filling the card. */}
        <Table className="w-max min-w-full">
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="border-border/60 bg-muted/[0.22] hover:bg-muted/[0.22]">
                  {hasSelection && (
                    <TableHead className="bg-muted/[0.22] w-12 ps-4 first:rounded-ss-2xl">
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
                              className="h-4 w-4"
                            />
                          );
                        }}
                      </table.Subscribe>
                    </TableHead>
                  )}
                  {hg.headers.map((h) => (
                    <TableHead
                      key={h.id}
                      className={cn(
                        "bg-muted/[0.22] px-3 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground first:rounded-ss-2xl last:rounded-se-2xl",
                        columnMeta(h.column).align === "end" && "text-end",
                        columnMeta(h.column).className,
                      )}
                    >
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                  {hasActions && (
                    <TableHead className="bg-muted/[0.22] px-3 text-end last:rounded-se-2xl">
                      {"Actions"}
                    </TableHead>
                  )}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: skeletonRows }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                    {hasSelection && (
                      <TableCell className="w-10 ps-4">
                        <Skeleton className="h-4 w-4 rounded" />
                      </TableCell>
                    )}
                    {columns.map((_col, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[160px]" />
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="w-12">
                        <Skeleton className="h-8 w-8 rounded-lg" />
                      </TableCell>
                    )}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length ? (
                table.getRowModel().rows.reduce<React.ReactNode[]>(
                  (acc, row, index) => {
                    if (groupBy && renderGroupHeader) {
                      const gk = groupBy(row.original);
                      if (
                        gk &&
                        (index === 0 ||
                          groupBy(
                            table.getRowModel().rows[index - 1].original,
                          ) !== gk)
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
                              className="bg-muted/20 hover:bg-muted/20 border-b-0"
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
                  <TableCell colSpan={totalColSpan} className="h-32">
                    {typeof emptyMessage === "string" || !emptyMessage ? (
                      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <Inbox className="h-8 w-8 opacity-50" />
                        <span className="text-sm">
                          {emptyMessage ?? "No results."}
                        </span>
                      </div>
                    ) : (
                      emptyMessage
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            {footer && table.getRowModel().rows.length > 0 && (
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  {hasSelection && <TableCell className="w-10 ps-4" />}
                  {table.getHeaderGroups()[0].headers.map((header) => {
                    const cell = footer.cells.find(
                      (c) => c.columnId === header.column.id,
                    );
                    const isEnd =
                      cell?.align === "end" || columnMeta(header.column).align === "end";
                    return (
                      <TableCell
                        key={header.column.id}
                        className={cn(isEnd && "text-end")}
                      >
                        {cell
                          ? cell.loading
                            ? <Skeleton className="h-4 w-16" />
                            : cell.render()
                          : " "}
                      </TableCell>
                    );
                  })}
                  {hasActions && <TableCell className="text-end" />}
                </TableRow>
              </TableFooter>
            )}
        </Table>
      </div>
      )}

      {/* CARD LIST — mobile viewport, or desktop opted in via `viewToggle`. */}
      {showCards && (renderMobileRow || renderFullRow) && (
        <div
          className={cn(
            "[&>div]:transition-colors",
            mobileListClassName ?? "space-y-2",
          )}
        >
          {isLoading ? (
            groupedMobile ? (
              <div className="space-y-3">
                {Array.from({ length: skeletonRows }).map((_, i) => (
                  <MobileRowSkeleton
                    key={`sk-${i}`}
                    className="rounded-xl border bg-card"
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from({ length: skeletonRows }).map((_, i) => (
                  <React.Fragment key={`sk-${i}`}>
                    {mobileRowSkeleton ?? (
                      <MobileRowSkeleton className="rounded-2xl border border-border/70 bg-card" />
                    )}
                  </React.Fragment>
                ))}
              </div>
            )
          ) : table.getRowModel().rows.length ? (
            groupedMobile ? (
              <div className="space-y-3">
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

                  // Real group: a single card binding its member rows. The
                  // header (count + actions) sits on a tinted strip on top; the
                  // members are always-visible connected rows below.
                  if (header) {
                    return (
                      <div
                        key={`group-${gk}`}
                        className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm shadow-black/[0.03]"
                      >
                        <div className="bg-muted/[0.28] px-4 py-3 border-b border-border/70">
                          {header}
                        </div>
                        <div className="divide-y divide-border">
                          {seg.rows.map(({ row, index }) =>
                            renderMobileCard(row, index, "px-4 py-3.5", `group-${gk}`),
                          )}
                        </div>
                      </div>
                    );
                  }

                  // Singletons: each row stands alone as its own card.
                  return seg.rows.map(({ row, index }) =>
                    renderMobileCard(
                      row,
                      index,
                      "rounded-2xl border border-border/70 bg-card px-4 py-3.5 shadow-sm shadow-black/[0.03]",
                      `singleton-${index}`,
                    ),
                  );
                })}
              </div>
            ) : mobileListClassName ? (
              table
                .getRowModel()
                .rows.map((row, rowIndex) => renderMobileCard(row, rowIndex))
            ) : (
              <>
                <div className="space-y-2">
                  {table
                    .getRowModel()
                    .rows.map((row, rowIndex) =>
                      renderMobileCard(row, rowIndex),
                    )}
                </div>
                {footer && footer.cells.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl border border-border/70 bg-muted/30 px-4 py-3 text-sm font-medium">
                    {footer.label && (
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        {footer.label}
                      </span>
                    )}
                    {footer.cells.map((c) => (
                      <span
                        key={c.columnId}
                        className="flex items-center gap-1.5 text-xs"
                      >
                        <span className="uppercase tracking-wide text-muted-foreground">
                          {footerLabel(c.columnId)}
                        </span>
                        {c.loading ? <Skeleton className="h-4 w-16" /> : c.render()}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )
          ) : typeof emptyMessage === "string" || !emptyMessage ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
              <Inbox className="h-8 w-8 opacity-30" />
              <span className="text-xs">
                {emptyMessage ?? "No results."}
              </span>
            </div>
          ) : (
            <div className="py-8">{emptyMessage}</div>
          )}
        </div>
      )}

      {/* Server-side pagination */}
      {paginationNode}

      {/* Client-side pagination */}
      {pageSize && !pagination && !isLoading && table.getPageCount() > 1 && (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs text-muted-foreground">
            {`Page ${table.state.pagination.pageIndex + 1} of ${table.getPageCount()}`}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-9"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="h-4 w-4 ltr:block rtl:hidden" />
              <ChevronRight className="h-4 w-4 ltr:hidden rtl:block" />
              {"Previous"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl h-9"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              {"Next"}
              <ChevronRight className="h-4 w-4 ltr:block rtl:hidden" />
              <ChevronLeft className="h-4 w-4 ltr:hidden rtl:block" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Default loading placeholder for one mobile card: title + subtitle on the
 *  start side, a value on the end side — the shape every card in the app has.
 *  Override per page via `mobile.rowSkeleton` when the real card differs. */
export function MobileRowSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-3.5",
        className,
      )}
    >
      <div className="flex-1 min-w-0 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-4 w-16 shrink-0" />
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

/** Sortable column header button — use as a column `header`. */
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
  return (
    <button
      type="button"
      className={cn(
        "-ms-1 inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase hover:text-foreground",
        column.getIsSorted() && "text-foreground",
      )}
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {children}
      <ArrowUpDown className="h-3 w-3" />
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
          className={cn("h-8 gap-1.5 rounded-md px-2.5 text-xs", className)} />}>
          <Rows3 className="h-3.5 w-3.5 opacity-60" />
          {`${value} rows`}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-32">
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