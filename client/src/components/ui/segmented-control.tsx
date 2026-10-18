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
 * iOS-style segmented control — a pill track with a sliding active segment.
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
        "flex w-full items-center gap-1 frame-xl bg-muted frame-p-1",
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
              "flex-1 rounded-inner px-3 py-1.5 text-sm font-medium transition-all",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground active:scale-95",
            )}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
