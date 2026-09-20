/**
 * App-wide TanStack Table v9 setup.
 *
 * v9 dropped v8's "every feature is always bundled" model — a table instance
 * only exposes the APIs of the features it registers, and every public type is
 * now generic over that feature set (`ColumnDef<TFeatures, TData, TValue>`).
 *
 * Every table in this app goes through `<DataTable>`, so there is exactly one
 * feature set and one set of defaults. `createTableHook` binds both once here;
 * the `ColumnDef` / `Row` aliases below re-expose the v8-shaped generics so all
 * the column-definition call sites stay unchanged.
 */
import {
  columnVisibilityFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  createTableHook,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
} from "@tanstack/react-table";
import type {
  ColumnDef as TanstackColumnDef,
  Row as TanstackRow,
  RowData,
} from "@tanstack/react-table";

/**
 * The features `<DataTable>` drives.
 *
 * Row selection and row expansion live in TanStack table state (not React
 * `useState`): that is what lets `<DataTable>` subscribe each memoized row to
 * only its own selected/expanded slice, so a checkbox tick or row expand
 * re-renders one row instead of the whole body. DataTable still lifts the
 * selection into a page-owned `Set<string>` via `onSelectedIdsChange` (a
 * commit-phase sync), preserving the existing `selection.ids` contract.
 *
 * Group headers are likewise not `columnGroupingFeature` — they're a
 * presentational grouping of already-flat rows, owned by React state.
 *
 * `rowExpandingFeature` deliberately has no `expandedRowModel` slot: our data
 * is flat, so expansion is only ever a per-row open/closed flag. Without the
 * slot that pipeline stage is a pass-through and `getRowModel()` is unchanged.
 *
 * ponytail: registering the whole `sortFns` registry (rather than the two or
 * three `sortFn_*` built-ins actually hit) keeps v8's automatic sort-fn
 * detection working for every column type. Costs a few kB; swap to explicit
 * entries if bundle size bites.
 */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowExpandingFeature,
  // Not for hiding columns — `row.getVisibleCells()` lives on this feature, and
  // both the desktop body and `renderMobileRow`'s `cell()` helper go through it.
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns,
});

export type DataTableFeatures = typeof dataTableFeatures;

export const { useAppTable, createAppColumnHelper } = createTableHook({
  features: dataTableFeatures,
  // Flat data has no sub-rows, so v9's default `getRowCanExpand` (which
  // requires `row.subRows.length`) is always false and `toggleExpanded()`
  // silently no-ops. DataTable uses expansion purely as a UI flag.
  getRowCanExpand: () => true,
});

/** v8-compatible `ColumnDef` shape, bound to this app's feature set. */
export type ColumnDef<TData extends RowData, TValue = unknown> =
  TanstackColumnDef<DataTableFeatures, TData, TValue>;

/** v8-compatible `Row` shape, bound to this app's feature set. */
export type Row<TData extends RowData> = TanstackRow<DataTableFeatures, TData>;

/** v8-compatible `createColumnHelper<TData>()`, bound to this app's features. */
export const createColumnHelper = createAppColumnHelper;
