import { cn } from "@/lib/utils";

interface Segment<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Segmented control in the registry `Tabs` default look — a muted track, the pick on the background.
 * Use for 2–4 mutually exclusive view/filter options on mobile.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex w-full items-center rounded-4xl bg-muted p-[3px] text-muted-foreground",
        className,
      )}
    >
      {segments.map((seg) => {
        const active = seg.value === value;
        return (
          <button
            key={seg.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => {
              if (!active) onChange(seg.value)
            }}
            className={cn(
              "flex-1 rounded-4xl border border-transparent px-3 py-1.5 text-sm font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
              active
                ? "bg-background text-foreground dark:border-input dark:bg-input/30"
                : "text-foreground/60 hover:text-foreground dark:text-muted-foreground",
            )}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
