"use client";

import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
  type PanInfo,
} from "framer-motion";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export type SwipeSide = "left" | "right";

export type SwipeableListValue = {
  id: string;
  side: SwipeSide;
};

export type SwipeNeighborMotion = {
  activeIndex: MotionValue<number>;
  activeScope: MotionValue<string | null>;
  x: MotionValue<number>;
};

export type SwipeActionTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger";

export type SwipeAction = {
  id: string;
  label: ReactNode;
  icon: ReactNode;
  tone?: SwipeActionTone;
  disabled?: boolean;
  onClick?: (item: SwipeableListItem) => void;
};

export type SwipeableListItem = {
  id: string;
  title?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  content?: ReactNode;
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  disabled?: boolean;
};

export type SwipeableListClassNames = {
  root?: string;
  item?: string;
  rail?: string;
  action?: string;
  surface?: string;
  leading?: string;
  content?: string;
  title?: string;
  description?: string;
  meta?: string;
};

export interface SwipeableListProps {
  items: SwipeableListItem[];
  value?: SwipeableListValue | null;
  defaultValue?: SwipeableListValue | null;
  onValueChange?: (value: SwipeableListValue | null) => void;
  onAction?: (payload: {
    item: SwipeableListItem;
    action: SwipeAction;
    side: SwipeSide;
  }) => void;
  actionWidth?: number;
  revealThreshold?: number;
  closeOnAction?: boolean;
  className?: string;
  classNames?: SwipeableListClassNames;
  renderItem?: (item: SwipeableListItem) => ReactNode;
  neighborMotion?: SwipeNeighborMotion;
  neighborIndex?: number;
  neighborScope?: string;
}

// Distance-based release spring keeps short rebounds and full reveals feeling
// equally direct, closer to native mobile list interactions.
const ROW_SETTLE = {
  type: "spring",
  stiffness: 560,
  damping: 48,
  mass: 0.82,
  restDelta: 0.5,
  restSpeed: 8,
} as const;
const OPEN_DISTANCE_RATIO = 0.46;
const CLOSE_DISTANCE_RATIO = 0.72;
const OPEN_VELOCITY = 720;
const CLOSE_VELOCITY = 320;
const FLING_DISTANCE = 14;
const RELEASE_VELOCITY_LIMIT = 1500;
// Magnetic field around the row's resting position: while the dragged row sits
// inside it the neighbouring rows are released and spring back to normal.
const NEIGHBOR_RETURN_FIELD = 4;
// How far the row can pull before the magnet snaps: past this the neighbours
// break free and settle back to rest while the row keeps travelling.
const NEIGHBOR_BREAK_DISTANCE = 44;
// Just before the break the magnet fights back: travel inside this band is
// compressed, so the row feels heavier right up until the magnet lets go.
const NEIGHBOR_RESIST_BAND = 16;
const NEIGHBOR_RESIST_FACTOR = 0.35;

const ACTION_TONE_CLASS: Record<SwipeActionTone, string> = {
  neutral: "text-muted-foreground group-hover:text-foreground",
  primary: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

function useControllableSwipeValue({
  value,
  defaultValue,
  onValueChange,
}: {
  value?: SwipeableListValue | null;
  defaultValue?: SwipeableListValue | null;
  onValueChange?: (value: SwipeableListValue | null) => void;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? null);
  const isControlled = value !== undefined;
  const currentValue = value ?? internalValue;

  const setValue = useCallback(
    (next: SwipeableListValue | null) => {
      if (!isControlled) {
        setInternalValue(next);
      }

      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  return [currentValue, setValue] as const;
}

function isActionableSide(value: number, sideWidth: number) {
  return sideWidth > 0 && Math.abs(value) > 0;
}

function clampReleaseVelocity(velocity: number) {
  return Math.max(
    -RELEASE_VELOCITY_LIMIT,
    Math.min(RELEASE_VELOCITY_LIMIT, velocity),
  );
}

function SwipeActionButton({
  action,
  actionWidth,
  side,
  focusable,
  onAction,
  className,
}: {
  action: SwipeAction;
  actionWidth: number;
  side: SwipeSide;
  focusable: boolean;
  onAction: (action: SwipeAction, side: SwipeSide) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      tabIndex={focusable ? 0 : -1}
      aria-label={typeof action.label === "string" ? action.label : undefined}
      onClick={() => onAction(action, side)}
      className={cn(
        "group flex h-full shrink-0 items-center justify-center outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      style={{ width: actionWidth }}
    >
      <span
        className={cn(
          "grid h-9 w-9 place-items-center rounded-full transition-[background-color,color,transform] duration-150 group-hover:bg-background group-active:scale-95",
          ACTION_TONE_CLASS[action.tone ?? "neutral"],
        )}
      >
        {action.icon}
      </span>
      <span className="sr-only">{action.label}</span>
    </button>
  );
}

function SwipeableListRow({
  item,
  actionWidth,
  revealThreshold,
  openValue,
  setOpenValue,
  closeOnAction,
  onAction,
  classNames,
  renderItem,
  neighborMotion,
  neighborIndex,
  neighborScope,
}: {
  item: SwipeableListItem;
  actionWidth: number;
  revealThreshold: number;
  openValue: SwipeableListValue | null;
  setOpenValue: (value: SwipeableListValue | null) => void;
  closeOnAction: boolean;
  onAction?: SwipeableListProps["onAction"];
  classNames?: SwipeableListClassNames;
  renderItem?: (item: SwipeableListItem) => ReactNode;
  neighborMotion?: SwipeNeighborMotion;
  neighborIndex?: number;
  neighborScope?: string;
}) {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const animationRef = useRef<{ stop: () => void } | null>(null);
  const commandedTargetRef = useRef(0);
  // Tracks whether the current pointer sequence moved past a real drag
  // threshold, so a swipe attempt (even one that snaps back to closed)
  // doesn't also fire the row's native onClick underneath it.
  const draggedRef = useRef(false);
  const magnetBrokeRef = useRef(false);
  const fallbackIndex = useMotionValue(-999);
  const fallbackScope = useMotionValue<string | null>(null);
  const fallbackX = useMotionValue(0);
  /* `useTransform`'s multi-value overload accepts `MotionValue<string>` or
     `MotionValue<number>`, and the scope is nullable ("no row is swiping"), so
     the tuple is cast at the boundary and the callback types its own
     parameters. Both are compile-time only — every read below already coerces
     with `Number()` or compares loosely, which is what made this invisible in
     the upstream project's non-strict build. */
  const magneticTarget = useTransform(
    [
      neighborMotion?.activeIndex ?? fallbackIndex,
      neighborMotion?.activeScope ?? fallbackScope,
      neighborMotion?.x ?? fallbackX,
    ] as unknown as MotionValue<number>[],
    ([activeIndex, activeScope, offset]: (number | string | null)[]) => {
      if (
        neighborIndex === undefined ||
        activeScope !== neighborScope ||
        Math.abs(Number(activeIndex) - neighborIndex) === 0 ||
        Math.abs(Number(activeIndex) - neighborIndex) > 2
      ) {
        return 0;
      }

      const distance = Number(offset);
      const travel = Math.abs(distance);
      // Below the field the magnet has no grip; past the break distance it
      // snaps and the neighbours drop back to rest mid-swipe.
      if (travel <= NEIGHBOR_RETURN_FIELD || travel >= NEIGHBOR_BREAK_DISTANCE) {
        return 0;
      }

      // The second ring trails well behind the first, so the pull reads as a
      // field falling off with distance rather than a rigid block.
      const isAdjacent = Math.abs(Number(activeIndex) - neighborIndex) === 1;
      const strength = isAdjacent ? 0.45 : 0.14;
      const cap = isAdjacent ? 26 : 8;
      const pull = (travel - NEIGHBOR_RETURN_FIELD) * strength;
      return Math.sign(distance) * Math.min(cap, pull);
    },
  );
  const neighborX = useSpring(magneticTarget as MotionValue<number>, {
    stiffness: 420,
    damping: 34,
    mass: 0.7,
  });
  useEffect(() => {
    if (!neighborMotion || neighborIndex === undefined || reduce) return;
    return x.on("change", (value) => {
      if (neighborMotion.activeIndex.get() === neighborIndex) {
        neighborMotion.x.set(value);
      }
    });
  }, [neighborIndex, neighborMotion, reduce, x]);

  const leftActions = item.leftActions ?? [];
  const rightActions = item.rightActions ?? [];
  const leftWidth = leftActions.length * actionWidth;
  const rightWidth = rightActions.length * actionWidth;
  const openSide = openValue?.id === item.id ? openValue.side : null;
  const targetX =
    openSide === "left" ? leftWidth : openSide === "right" ? -rightWidth : 0;

  const settleX = useCallback(
    (nextX: number, velocity = 0) => {
      commandedTargetRef.current = nextX;
      animationRef.current?.stop();

      if (reduce) {
        x.set(nextX);
        return;
      }

      animationRef.current = animate(x, nextX, {
        ...ROW_SETTLE,
        velocity: clampReleaseVelocity(velocity),
        onComplete: () => x.set(nextX),
      });
    },
    [reduce, x],
  );

  useEffect(() => {
    return () => animationRef.current?.stop();
  }, []);

  useEffect(() => {
    if (commandedTargetRef.current === targetX) {
      return;
    }

    settleX(targetX);
  }, [settleX, targetX]);

  const getTargetX = useCallback(
    (side: SwipeSide | null) =>
      side === "left" ? leftWidth : side === "right" ? -rightWidth : 0,
    [leftWidth, rightWidth],
  );

  const snapTo = useCallback(
    (side: SwipeSide | null, velocity = 0) => {
      setOpenValue(side ? { id: item.id, side } : null);
      settleX(getTargetX(side), velocity);
    },
    [getTargetX, item.id, setOpenValue, settleX],
  );

  const onDragStart = useCallback(() => {
    animationRef.current?.stop();
    magnetBrokeRef.current = false;
    if (neighborMotion && neighborIndex !== undefined && !reduce) {
      neighborMotion.activeIndex.set(neighborIndex);
      neighborMotion.activeScope.set(neighborScope ?? null);
      neighborMotion.x.set(x.get());
    }
    draggedRef.current = false;

    if (openValue && openValue.id !== item.id) {
      setOpenValue(null);
    }
  }, [item.id, neighborIndex, neighborMotion, neighborScope, openValue, reduce, setOpenValue, x]);

  const onDrag = useCallback((_: PointerEvent, info: PanInfo) => {
    // A few px of jitter shouldn't count as a drag — only mark it once the
    // gesture clearly moved, so real taps still reach onClick.
    if (Math.abs(info.offset.x) > 4) {
      draggedRef.current = true;
    }
    if (neighborMotion && neighborIndex !== undefined && !reduce) {
      // Re-arm every frame: the field below decides whether neighbours are
      // held or released, so the channel must stay live for the whole drag.
      neighborMotion.activeIndex.set(neighborIndex);
      neighborMotion.activeScope.set(neighborScope ?? null);

      const raw = x.get();
      const travel = Math.abs(raw);
      // Drag through the resist band feels heavy: the row lags the finger
      // until the magnet snaps, then catches up to normal tracking.
      const resistStart = NEIGHBOR_BREAK_DISTANCE - NEIGHBOR_RESIST_BAND;
      if (travel > resistStart && travel < NEIGHBOR_BREAK_DISTANCE) {
        const held =
          resistStart + (travel - resistStart) * NEIGHBOR_RESIST_FACTOR;
        x.set(Math.sign(raw) * held);
      }

      const broke = travel >= NEIGHBOR_BREAK_DISTANCE;
      if (broke && !magnetBrokeRef.current) {
        magnetBrokeRef.current = true;
        navigator.vibrate?.(12);
      } else if (!broke && travel <= resistStart) {
        magnetBrokeRef.current = false;
      }

      neighborMotion.x.set(x.get());
    }
  }, [neighborIndex, neighborMotion, neighborScope, reduce, x]);

  const onSurfaceClickCapture = useCallback((e: ReactMouseEvent) => {
    if (draggedRef.current) {
      e.stopPropagation();
      e.preventDefault();
      draggedRef.current = false;
    }
  }, []);

  const onDragEnd = useCallback(
    (_: PointerEvent, info: PanInfo) => {
      const velocity = info.velocity.x;
      const latest = x.get();
      if (neighborMotion && !reduce) {
        animate(neighborMotion.x, 0, {
          ...ROW_SETTLE,
          velocity: clampReleaseVelocity(velocity),
          onComplete: () => {
            neighborMotion.activeIndex.set(-1);
            neighborMotion.activeScope.set(null);
          },
        });
      }
      const leftOpenThreshold = Math.max(
        revealThreshold,
        leftWidth * OPEN_DISTANCE_RATIO,
      );
      const rightOpenThreshold = Math.max(
        revealThreshold,
        rightWidth * OPEN_DISTANCE_RATIO,
      );

      if (openSide === "left") {
        if (
          latest < leftWidth * CLOSE_DISTANCE_RATIO ||
          velocity < -CLOSE_VELOCITY
        ) {
          snapTo(null, velocity);
          return;
        }

        snapTo("left", velocity);
        return;
      }

      if (openSide === "right") {
        if (
          Math.abs(latest) < rightWidth * CLOSE_DISTANCE_RATIO ||
          velocity > CLOSE_VELOCITY
        ) {
          snapTo(null, velocity);
          return;
        }

        snapTo("right", velocity);
        return;
      }

      if (
        isActionableSide(latest, leftWidth) &&
        (latest > leftOpenThreshold ||
          (velocity > OPEN_VELOCITY && latest > FLING_DISTANCE))
      ) {
        snapTo("left", velocity);
        return;
      }

      if (
        isActionableSide(latest, rightWidth) &&
        (latest < -rightOpenThreshold ||
          (velocity < -OPEN_VELOCITY && latest < -FLING_DISTANCE))
      ) {
        snapTo("right", velocity);
        return;
      }

      snapTo(null, velocity);
    },
    [
      leftWidth,
      neighborMotion,
      openSide,
      reduce,
      revealThreshold,
      rightWidth,
      snapTo,
      x,
    ],
  );

  const handleAction = useCallback(
    (action: SwipeAction, side: SwipeSide) => {
      action.onClick?.(item);
      onAction?.({ item, action, side });

      if (closeOnAction) {
        snapTo(null);
      }
    },
    [closeOnAction, item, onAction, snapTo],
  );

  const defaultContent = (
    <div className="flex min-w-0 items-center gap-3">
      {item.leading ? (
        <div className={cn("shrink-0", classNames?.leading)}>
          {item.leading}
        </div>
      ) : null}
      <div className={cn("min-w-0 flex-1", classNames?.content)}>
        {item.title ? (
          <div
            className={cn(
              "truncate text-sm font-medium text-foreground",
              classNames?.title,
            )}
          >
            {item.title}
          </div>
        ) : null}
        {item.description ? (
          <div
            className={cn(
              "mt-0.5 truncate text-xs text-muted-foreground",
              classNames?.description,
            )}
          >
            {item.description}
          </div>
        ) : null}
      </div>
      {item.meta ? (
        <div
          className={cn(
            "shrink-0 text-xs font-medium text-muted-foreground",
            classNames?.meta,
          )}
        >
          {item.meta}
        </div>
      ) : null}
    </div>
  );

  return (
    <motion.div
      style={{ x: neighborX }}
      className={cn(
        "relative isolate overflow-hidden rounded-xl bg-transparent",
        item.disabled && "opacity-60",
        classNames?.item,
      )}
    >
      <div
        aria-hidden={!openSide}
        className={cn(
          "absolute inset-0 z-0 flex overflow-hidden rounded-[inherit]",
          classNames?.rail,
        )}
      >
        <div className="flex h-full overflow-hidden rounded-s-[inherit]">
          {leftActions.map((action) => (
            <SwipeActionButton
              key={action.id}
              action={action}
              actionWidth={actionWidth}
              className={classNames?.action}
              focusable={openSide === "left"}
              onAction={handleAction}
              side="left"
            />
          ))}
        </div>
        <div className="ms-auto flex h-full overflow-hidden rounded-e-[inherit]">
          {rightActions.map((action) => (
            <SwipeActionButton
              key={action.id}
              action={action}
              actionWidth={actionWidth}
              className={classNames?.action}
              focusable={openSide === "right"}
              onAction={handleAction}
              side="right"
            />
          ))}
        </div>
      </div>

      <motion.div
        drag={item.disabled ? false : "x"}
        dragConstraints={{ left: -rightWidth, right: leftWidth }}
        dragElastic={0.04}
        dragMomentum={false}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onClickCapture={onSurfaceClickCapture}
        style={{ x }}
        className={cn(
          "relative z-10 min-h-[72px] cursor-grab touch-pan-y select-none rounded-xl border border-border bg-card px-4 py-3 shadow-sm active:cursor-grabbing",
          classNames?.surface,
        )}
      >
        {renderItem ? renderItem(item) : item.content ?? defaultContent}
      </motion.div>
    </motion.div>
  );
}

export function SwipeableList({
  items,
  value,
  defaultValue = null,
  onValueChange,
  onAction,
  actionWidth = 56,
  revealThreshold = 34,
  closeOnAction = true,
  className,
  classNames,
  renderItem,
  neighborMotion,
  neighborIndex,
  neighborScope,
}: SwipeableListProps) {
  const [openValue, setOpenValue] = useControllableSwipeValue({
    value,
    defaultValue,
    onValueChange,
  });

  return (
    <div className={cn("flex w-full flex-col gap-2", className, classNames?.root)}>
      {items.map((item) => (
        <SwipeableListRow
          key={item.id}
          item={item}
          actionWidth={actionWidth}
          revealThreshold={revealThreshold}
          openValue={openValue}
          setOpenValue={setOpenValue}
          closeOnAction={closeOnAction}
          onAction={onAction}
          classNames={classNames}
          renderItem={renderItem}
          neighborMotion={neighborMotion}
          neighborIndex={neighborIndex}
          neighborScope={neighborScope}
        />
      ))}
    </div>
  );
}
