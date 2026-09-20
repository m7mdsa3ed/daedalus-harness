import { type ReactNode } from "react";
import { Trash2, Pencil } from "lucide-react";
import {
  SwipeableList,
  type SwipeAction as BeuiSwipeAction,
  type SwipeNeighborMotion,
} from "@/components/motion/swipeable-list";

interface SwipeAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  className?: string;
}

interface SwipeableRowProps {
  children: ReactNode;
  onSwipeLeft?: SwipeAction[];
  /** Actions revealed when the user swipes RIGHT (the row moves right, exposing a left rail). */
  onSwipeRight?: SwipeAction[];
  disabled?: boolean;
  className?: string;
  neighborMotion?: SwipeNeighborMotion;
  neighborIndex?: number;
  neighborScope?: string;
}

/**
 * Thin adapter over beui.dev's <SwipeableList> (src/components/motion/swipeable-list.tsx).
 * Keeps the existing per-row API used across the app — `children` plus an
 * `onSwipeLeft` action list — while delegating the gesture/physics to beui.
 *
 * beui owns the row chrome by default (its own `border bg-card shadow-sm` card and
 * icon-circle actions). Our row children already render their own card surface, so
 * `surface`/`item` are flattened here to avoid double-carding, and actions are mapped
 * to beui's icon-circle model (label kept for screen readers).
 */
const STRIP_SURFACE =
  "min-h-0 rounded-lg border-0 bg-background p-0 shadow-none cursor-auto active:cursor-auto";

export function SwipeableRow({
  children,
  onSwipeLeft,
  onSwipeRight,
  disabled,
  className,
  neighborMotion,
  neighborIndex,
  neighborScope,
}: SwipeableRowProps) {
  const rightActions: BeuiSwipeAction[] = (onSwipeLeft ?? []).map((action, index) => ({
    id: String(index),
    label: action.label,
    icon: action.icon ?? <Trash2 className="h-5 w-5" />,
    tone: action.className?.includes("destructive") ? "danger" : "neutral",
    onClick: action.onClick,
  }));

  const leftActions: BeuiSwipeAction[] = (onSwipeRight ?? []).map((action, index) => ({
    id: `right-${index}`,
    label: action.label,
    icon: action.icon ?? <Pencil className="h-5 w-5" />,
    tone: action.className?.includes("destructive") ? "danger" : "neutral",
    onClick: action.onClick,
  }));

  return (
    <SwipeableList
      className="gap-0"
      items={[{ id: "row", content: children, rightActions, leftActions, disabled }]}
      classNames={{
        // Shadow lives on the outer `item` — the `surface` sits inside beui's
        // `overflow-hidden` row container, which would clip a shadow placed there.
        root: className,
        item: "rounded-lg shadow-sm",
        surface: STRIP_SURFACE,
      }}
      neighborMotion={neighborMotion}
      neighborIndex={neighborIndex}
      neighborScope={neighborScope}
    />
  );
}
