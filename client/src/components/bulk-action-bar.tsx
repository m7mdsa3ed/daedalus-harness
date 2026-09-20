import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface BulkAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: "default" | "destructive" | "outline";
  disabled?: boolean;
}

interface BulkActionBarProps {
  selectedCount: number;
  isAllSelected: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  actions: BulkAction[];
  totalCount?: number;
  onSelectAllMatching?: () => void;
  className?: string;
}

export function BulkActionBar({
  selectedCount,
  isAllSelected,
  onToggleAll,
  onClear,
  actions,
  totalCount,
  onSelectAllMatching,
  className,
}: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <>
      {/* Mobile: fixed bottom bar */}
      <div className={cn("fixed inset-x-0 bottom-0 z-50 border-t border-border/80 bg-background/95 pb-safe shadow-[0_-8px_24px_-18px_black] backdrop-blur md:hidden", className)}>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex items-center gap-2 min-w-0">
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={onToggleAll}
              className="h-4 w-4 shrink-0"
            />
            <span className="text-sm font-medium truncate">
              {`${selectedCount} selected`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="h-8 text-xs px-2"
            >
              {"Clear"}
            </Button>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {actions.map((action, index) => (
              <Button
                key={index}
                variant={action.variant || "default"}
                size="sm"
                onClick={action.onClick}
                disabled={action.disabled}
                className="gap-1.5 h-9"
              >
                {action.icon}
                <span className="text-xs">{action.label}</span>
              </Button>
            ))}
          </div>
        </div>
        {totalCount !== undefined && onSelectAllMatching && selectedCount > 0 && !isAllSelected && totalCount > selectedCount && (
          <div className="flex items-center justify-center gap-1.5 border-t bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
            <span>{`All ${selectedCount} on this page selected`}</span>
            <Button
              variant="link"
              size="sm"
              onClick={onSelectAllMatching}
              className="h-auto p-0 text-xs text-primary"
            >
              {`Select all ${totalCount}`}
            </Button>
          </div>
        )}
      </div>

      {/* Desktop: inline bar */}
      <div className={cn("mb-4 hidden md:block", className)}>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-primary/15 bg-primary/[0.04] p-3.5 shadow-sm shadow-black/[0.02]">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={onToggleAll}
            />
            <span className="text-sm font-medium">
              {`${selectedCount} selected`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              className="text-xs"
            >
              {"Clear"}
            </Button>
          </div>
          <div className="flex gap-2">
            {actions.map((action, index) => (
              <Button
                key={index}
                variant={action.variant || "default"}
                size="sm"
                onClick={action.onClick}
                disabled={action.disabled}
                className="gap-2"
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        </div>
        {totalCount !== undefined && onSelectAllMatching && selectedCount > 0 && !isAllSelected && totalCount > selectedCount && (
          <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/50 p-2 text-sm mt-2">
            <span>{`All ${selectedCount} on this page selected`}</span>
            <Button
              variant="link"
              size="sm"
              onClick={onSelectAllMatching}
              className="h-auto p-0 text-primary"
            >
              {`Select all ${totalCount}`}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
