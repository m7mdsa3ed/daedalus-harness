import { useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link } from "react-router";
import { HeaderAction, type HeaderActionItem } from "@/components/ui/header-action";
import { cn } from "@/lib/utils";

interface HeaderActionOverflowProps {
  items: HeaderActionItem[];
  /** Max icons before collapsing the rest into a "more" popover. */
  maxVisible?: number;
  /** Show labels next to icons (desktop). Required for width-based folding to be meaningful. */
  withLabel?: boolean;
  /**
   * Measure the available width and hide only as many rightmost actions as
   * won't fit, instead of a fixed `maxVisible` cap. Keeps many actions visible
   * on a wide window and folds to a "⋯" dropdown on a narrow one.
   */
  responsive?: boolean;
  /** Button height, passed through to each action. */
  size?: "sm" | "md";
  /** Give the icon-only actions a visible border (label lives in the tooltip). */
  bordered?: boolean;
}

/** `gap-1.5` between sibling inline actions. */
const GAP = 6;
/** A `.size-8`/`.size-9` icon button (the "more" trigger). */
const MORE_W = { sm: 32, md: 36 } as const;
/** Slop kept free so a 1px measurement rounding can't cause fold/unfold flapping. */
const BUFFER = 8;

/** Laid-out width of an element's children, gaps included. */
function contentWidth(el: HTMLElement) {
  const kids = Array.from(el.children) as HTMLElement[];
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  return kids.reduce((w, k) => w + k.offsetWidth, 0) + Math.max(0, kids.length - 1) * gap;
}

/** Width an element could still give away before its content is squeezed. */
const freeSpace = (el: HTMLElement) => Math.max(0, el.clientWidth - contentWidth(el));

/**
 * Room the action row may occupy — its current width PLUS every pocket of
 * unclaimed width in the header.
 *
 * Measuring the row alone is circular: the row is content-sized, so folding an
 * action makes it narrower, which makes the next measurement see less room —
 * a one-way ratchet that never unfolds when the window widens again. Adding the
 * slack back keeps the budget constant across fold states.
 */
function availableWidth(row: HTMLElement) {
  const container = row.closest<HTMLElement>("[data-header-fit]");
  if (!container) return row.clientWidth;
  // Free space directly in the header row (e.g. an `ml-auto` gap on mobile)…
  let slack = freeSpace(container);
  // …plus slack hiding inside flex-1 slots, which swallow it before it ever
  // shows up as free space on the container.
  for (const el of container.querySelectorAll<HTMLElement>("[data-header-slack]")) {
    slack += freeSpace(el);
  }
  return row.clientWidth + slack - BUFFER;
}

/** How many of `widths` fit in `available`, reserving the "⋯" trigger if any are dropped. */
function fitCount(widths: number[], available: number, moreW: number) {
  for (let count = widths.length; count > 0; count--) {
    let sum = widths.slice(0, count).reduce((s, w) => s + w, 0) + (count - 1) * GAP;
    if (count < widths.length) sum += moreW + GAP;
    if (sum <= available) return count;
  }
  return 0;
}

/**
 * Renders a row of header action icon buttons, collapsing the overflow into a
 * "⋯" popover so a crowded header never overflows the viewport.
 *
 * Two collapse modes:
 *  - `responsive` (desktop): renders an off-screen measurement copy of every
 *    action, reads each natural width, and greedy-fills the live row until it
 *    would overflow the measured container — folding ONLY the rightmost
 *    actions that don't fit. A `ResizeObserver` re-runs the fit on resize.
 *  - without it (fallback): a fixed `maxVisible` count.
 *
 * The overflow popover lists actions as labeled rows (icon + label) — labels
 * matter where the inline buttons' tooltips don't trigger.
 */
export function HeaderActionOverflow({
  items,
  maxVisible = 3,
  withLabel,
  responsive,
  size = "sm",
  bordered = false,
}: HeaderActionOverflowProps) {
  const [open, setOpen] = useState(false);
  // Measured fit: how many actions fold into the dropdown, and whether the
  // still-visible ones dropped their labels to buy the room.
  const [fit, setFit] = useState({ hidden: 0, compact: false });
  const rowRef = useRef<HTMLDivElement>(null);
  const labeledRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const sig = items.map((i) => i.key).join("|");

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!responsive || !row) return;

    const measure = () => {
      const labeled = labeledRef.current;
      const icons = iconRef.current;
      if (!labeled || !icons) return;
      const available = availableWidth(row);
      const widthsOf = (el: HTMLElement) =>
        Array.from(el.children).map((c) => (c as HTMLElement).offsetWidth);

      // Degrade in order: full labels → icon-only → fold the rightmost icons.
      if (withLabel && fitCount(widthsOf(labeled), available, MORE_W[size]) === items.length) {
        setFit({ hidden: 0, compact: false });
        return;
      }
      const iconWidths = widthsOf(icons);
      setFit({
        hidden: items.length - fitCount(iconWidths, available, MORE_W[size]),
        compact: !!withLabel,
      });
    };

    const ro = new ResizeObserver(measure);
    ro.observe(row);
    const container = row.closest("[data-header-fit]");
    if (container) ro.observe(container);
    measure(); // initial fit on mount
    return () => ro.disconnect();
  }, [responsive, sig, items.length, withLabel, size]);

  // Responsive mode uses the measured fit; otherwise fall back to the fixed
  // `maxVisible` cap (mobile: width-constrained anyway, so count-based is fine).
  const visible = responsive
    ? items.length - fit.hidden
    : Math.min(maxVisible, items.length);
  // Labels survive only while nothing had to be given up for them.
  const showLabels = withLabel && !(responsive && fit.compact);
  const inline = items.slice(0, visible);
  const overflow = items.slice(visible);
  const showMore = overflow.length > 0;

  return (
    <>
      {/* Off-screen copies of every action at natural width — one labeled, one
          icon-only — so the fit pass can price both degradation stages without
          mutating the live row. */}
      {responsive && (
        <div aria-hidden className="pointer-events-none absolute invisible">
          <div ref={labeledRef} className="flex">
            {items.map(({ key, ...item }) => (
              <HeaderAction key={key} {...item} withLabel={withLabel} size={size} bordered={bordered} />
            ))}
          </div>
          <div ref={iconRef} className="flex">
            {items.map(({ key, ...item }) => (
              <HeaderAction key={key} {...item} size={size} bordered={bordered} />
            ))}
          </div>
        </div>
      )}

      {/* Live row — ref observed via ResizeObserver. */}
      <div ref={rowRef} className="flex min-w-0 items-center gap-1.5">
        {inline.map(({ key, ...item }) => (
          <HeaderAction key={key} {...item} withLabel={showLabels} size={size} bordered={bordered} />
        ))}

        {showMore && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={<Button type="button" size="icon" variant={bordered ? "outline" : "ghost"} aria-label="More actions" className={cn(size === "md" ? "size-9" : "size-8", "rounded-md")} />}>
                <MoreHorizontal />
              
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              sideOffset={8}
              className="w-56! rounded-xl p-1"
            >
              {overflow.map((item) => {
                const content = (
                  <>
                    <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-5">
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </>
                );
                const className = cn(
                  "w-full flex items-center gap-3 p-2.5 rounded-xl text-sm hover:bg-accent/5 transition-colors disabled:pointer-events-none disabled:opacity-50",
                  item.destructive && "text-destructive",
                );
                const close = () => setOpen(false);

                return item.href ? (
                  <Link key={item.key} to={item.href} className={className} onClick={close}>
                    {content}
                  </Link>
                ) : (
                  <button
                    key={item.key}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      item.onClick?.();
                      close();
                    }}
                    className={className}
                  >
                    {content}
                  </button>
                );
              })}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </>
  );
}