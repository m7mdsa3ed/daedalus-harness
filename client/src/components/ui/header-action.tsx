import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

export interface HeaderActionItem {
  key: string;
  /** Accessible label + tooltip text; also shown inline on desktop when `withLabel`. */
  label: string;
  icon: ReactNode;
  /** Navigate on click (renders a Link). Mutually exclusive with `onClick`. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** The page's main action (e.g. "New …"); ordered first in the header. */
  primary?: boolean;
  destructive?: boolean;
  /** Button height: "sm" = 32px (site header), "md" = 36px (table filter bar). */
  size?: "sm" | "md";
  /** Give the icon button a visible border (useful for icon-only toolbar actions
   *  that rely on their tooltip for a label). */
  bordered?: boolean;
}

/**
 * A single page header action. By default an icon-only button whose label lives
 * in the tooltip; pass `withLabel` to also render the label inline on desktop
 * (icon + text pill). On mobile it stays a compact icon button either way — the
 * floating header pill has no room for text — so the label is `hidden md:inline`.
 *
 * Self-sizes to `size-8` so `SiteHeader`'s action groups don't need a global
 * descendant override (which would fight the desktop pill sizing).
 */
export function HeaderAction({
  label,
  icon,
  href,
  onClick,
  disabled,
  destructive,
  withLabel,
  size = "sm",
  bordered = false,
}: Omit<HeaderActionItem, "key"> & { withLabel?: boolean }) {
  const md = size === "md";
  const button = (
    <Button
      type="button"
      size="icon"
      variant={bordered ? "outline" : "ghost"}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        md ? "size-9" : "size-8",
        "rounded-md",
        // Desktop: expand to an icon + label pill.
        withLabel && (md ? "md:h-9 md:w-auto md:gap-1.5 md:px-3" : "md:h-8 md:w-auto md:gap-1.5 md:px-3"),
        destructive && "text-destructive hover:text-destructive",
      )}
      render={href ? <Link to={href} className="flex items-center gap-1.5" /> : undefined}
      nativeButton={!href}
    >
      {icon}
      {withLabel && <span className="hidden md:inline text-sm">{label}</span>}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      {/* Tooltip is desktop-affordance; harmless on touch (won't trigger).
          Skip it when the label is already visible on desktop. */}
      {!withLabel && <TooltipContent>{label}</TooltipContent>}
    </Tooltip>
  );
}
