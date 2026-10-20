import * as React from "react";
import type { ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import { useCoarsePointer, useIsMobile } from "@/hooks/use-device";

/** One option for select / multi-select / segmented fields. */
export interface FilterOption {
  value: string;
  label: string;
}

/** A single filter field, described declaratively. FiltersBar dispatches on
 *  `type` to render the matching control and reads/writes the field's value
 *  from the shared `values` map by `id`. */
export type FilterFieldDef =
  | {
      id: string;
      label: string;
      type: "multi-select";
      options: MultiSelectOption[];
      placeholder?: string;
      searchPlaceholder?: string;
      emptyMessage?: string;
    }
  | {
      id: string;
      label: string;
      type: "select";
      options: FilterOption[];
      placeholder?: string;
    }
  | {
      id: string;
      label: string;
      type: "segmented";
      options: FilterOption[];
    }
  | {
      id: string;
      label: string;
      type: "switch";
    }
  | {
      id: string;
      label: string;
      type: "input";
      placeholder?: string;
    }
  | {
      /** Escape hatch for controls that don't fit the schema (e.g. a date-range
       *  picker with presets). `render` owns the whole field incl. its label. */
      id: string;
      label?: string;
      type: "custom";
      render: () => ReactNode;
    };

/** Plain field-id → value map. Pages own the mapping and URL sync; FiltersBar
 *  is purely presentational. */
export type FilterSchemaValue = Record<
  string,
  string[] | string | boolean | undefined
>;

export interface FiltersBarProps {
  /** Optional free-text search input rendered inline next to the filter button. */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  /** Filter field definitions. Omit to hide the filters button entirely. */
  fields?: FilterFieldDef[];
  /** Current values keyed by field id. */
  values: FilterSchemaValue;
  /** Called with (fieldId, nextValue) when a control changes. */
  onFilterChange: (id: string, value: string[] | string | boolean) => void;
  /** Number of active filters — shown as a badge on the Filters button. */
  filterCount?: number;
  /** Clear-all handler; shows a clear button in the popover when count > 0. */
  onClearFilters?: () => void;
  /** Trailing control rendered at the end of the bar (e.g. rows-per-page). */
  trailing?: ReactNode;
  /** Whether the *panel* is narrow (the table measures it). Picks the drawer
   *  over the popover and the icon-only trigger; defaults to the window. */
  narrow?: boolean;
  className?: string;
}

/** Renders a control for a single field based on its `type`. */
function FilterFieldControl({
  field,
  value,
  onChange,
}: {
  field: FilterFieldDef;
  value: FilterSchemaValue[string];
  onChange: FiltersBarProps["onFilterChange"];
}) {
  switch (field.type) {
    case "multi-select":
      return (
        <MultiSelect
          options={field.options}
          selected={(value as string[] | undefined) ?? []}
          onChange={(next) => onChange(field.id, next)}
          placeholder={field.placeholder}
          searchPlaceholder={field.searchPlaceholder}
          emptyMessage={field.emptyMessage}
        />
      );
    case "select": {
      const current = (value as string | undefined) ?? "";
      return (
        <Select value={current} onValueChange={(next) => onChange(field.id, next ?? "")}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case "segmented":
      return (
        <SegmentedControl
          segments={field.options}
          value={(value as string) ?? ""}
          onChange={(next) => onChange(field.id, next)}
        />
      );
    case "switch":
      return (
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(next) => onChange(field.id, next)}
        />
      );
    case "input":
      return (
        <Input
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(field.id, e.target.value)}
          className="h-10 md:h-9"
        />
      );
    case "custom":
      return <>{field.render()}</>;
    default:
      return null;
  }
}

/**
 * Table-owned search + filter bar. Renders a search input (optional) and a
 * Filters button (with active-count badge) that opens a filter panel holding
 * the declarative `fields`. The table — not the page or PageToolbar — decides
 * where the bar sits, so filter state is always visually tied to the data it
 * drives.
 *
 * Desktop uses a popover; mobile uses the shared ResponsiveDialog, which
 * renders as a bottom drawer. Search takes the full width with the filter
 * button + trailing control below it on mobile.
 */
export function FiltersBar({
  search,
  fields,
  values,
  onFilterChange,
  filterCount = 0,
  onClearFilters,
  trailing,
  narrow,
  className,
}: FiltersBarProps) {
  const windowNarrow = useIsMobile();
  const isMobile = narrow ?? windowNarrow;
  const coarse = useCoarsePointer();
  const hasFilters = Boolean(fields && fields.length);
  const [mobileFiltersOpen, setMobileFiltersOpen] = React.useState(false);

  const filterButton = hasFilters ? (
    <Button
      type="button"
      variant="outline"
      size={isMobile ? "icon" : "default"}
      className={cn("relative shrink-0 gap-2", coarse ? "h-11 min-w-11" : "h-9")}
      onClick={isMobile ? () => setMobileFiltersOpen(true) : undefined}
    >
      <SlidersHorizontal className="size-4" />
      {!isMobile && <span>{"Filters"}</span>}
      {filterCount > 0 && (
        <Badge
          variant="secondary"
          className={cn(
            "justify-center",
            isMobile
              ? "pointer-events-none absolute -end-1.5 -top-1.5 h-4 min-w-4 px-1"
              : "ms-0.5 h-5 min-w-5 px-1",
          )}
        >
          {filterCount}
        </Badge>
      )}
    </Button>
  ) : null;

  // Built lazily and memoised: on mobile this whole tree is several Radix
  // popover roots, and rebuilding it on every keystroke in the search box (the
  // bar re-renders per character) is wasted work the docked panel pays for.
  const buildFilterContent = () => (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-heading text-base font-medium">{"Filters"}</p>
        {filterCount > 0 && onClearFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11 pointer-coarse:px-3"
            onClick={clearFilters}
          >
            <X className="size-3" />
            {"Clear all"}
          </Button>
        )}
      </div>
      {fields?.map((field) => (
        <div key={field.id}>
          {field.type === "custom" ? (
            field.render()
          ) : field.type === "switch" ? (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={`filter-${field.id}`} className="cursor-pointer text-sm font-medium">
                {field.label}
              </Label>
              <FilterFieldControl field={field} value={values[field.id]} onChange={changeFilter} />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{field.label}</Label>
              <FilterFieldControl field={field} value={values[field.id]} onChange={changeFilter} />
            </div>
          )}
        </div>
      ))}
    </div>
  );

  // Handlers go through a ref: pages pass fresh closures every render
  // (`onChange: (id, v) => updateFilters(...)`), which would bust the memo below
  // on every parent render and — while docked — push a new node into the Now Bar
  // deck each time, re-rendering the whole panel mid-animation.
  const handlers = React.useRef({ onFilterChange, onClearFilters });
  handlers.current = { onFilterChange, onClearFilters };
  const changeFilter = React.useCallback<FiltersBarProps["onFilterChange"]>(
    (id, value) => handlers.current.onFilterChange(id, value),
    [],
  );
  const clearFilters = React.useCallback(() => handlers.current.onClearFilters?.(), []);

  // Same reason for `values`: pages build the map inline, so it is a new object
  // every render even when nothing changed. Compare by content instead.
  const valuesKey = JSON.stringify(values);

  const filterContent = React.useMemo(
    () => (isMobile && !mobileFiltersOpen ? null : buildFilterContent()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMobile, mobileFiltersOpen, fields, valuesKey, filterCount],
  );

  return (
    <div data-header-fit className={cn("flex flex-wrap items-center gap-2", className)}>
      {search && (
        // The search owns the first line on a narrow panel and the rest wrap
        // under it; wide, it sits at the start and takes what the bar leaves.
        <div className={cn("relative min-w-0", isMobile ? "w-full" : "w-auto max-w-sm flex-1")}>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
            aria-label={search.placeholder ?? "Search"}
            className={cn(
              "ps-9 pe-9 [&::-webkit-search-cancel-button]:hidden",
              coarse ? "h-11" : "h-9",
            )}
          />
          {search.value && (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => search.onChange("")}
              className={cn(
                "absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                coarse ? "end-0 size-11" : "end-1 size-7",
              )}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {hasFilters && (isMobile ? (
        // Mobile filters render in a full-screen bottom drawer (not the Now Bar
        // pill), so the panel opens with the page's normal drawer chrome.
        <ResponsiveDialog open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Filters"
            className={cn("relative shrink-0 gap-2", coarse ? "size-11" : "size-9")}
            onClick={() => setMobileFiltersOpen(true)}
          >
            <SlidersHorizontal className="size-4" />
            {filterCount > 0 && <Badge variant="secondary" className="pointer-events-none absolute -end-1.5 -top-1.5 h-4 min-w-4 px-1">{filterCount}</Badge>}
          </Button>
          <ResponsiveDialogContent className="max-h-[85dvh]">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{"Filters"}</ResponsiveDialogTitle>
            </ResponsiveDialogHeader>
            <div className="w-full">{filterContent}</div>
          </ResponsiveDialogContent>
        </ResponsiveDialog>
      ) : (
        <Popover>
          <PopoverTrigger render={filterButton!} />
          <PopoverContent align="start" sideOffset={8} className="w-[min(20rem,calc(100vw-2rem))] p-4">
            {filterContent}
          </PopoverContent>
        </Popover>
      ))}

      {trailing && (
        <div
          data-header-slack
          className="ms-auto flex min-w-0 flex-1 items-center justify-end"
        >
          {trailing}
        </div>
      )}
    </div>
  );
}
