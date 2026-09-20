import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination";
import { cn } from "@/lib/utils";

interface PaginationControlsProps {
  page: number;
  totalPages: number;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Page-based prev/next pagination control. Replaces infinite scroll on list
 * pages so only one page of data is ever held/rendered.
 */
export function PaginationControls({
  page,
  totalPages,
  hasPrev,
  hasNext,
  onPageChange,
  className,
}: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  const canPrev = hasPrev ?? page > 1;
  const canNext = hasNext ?? page < totalPages;

  return (
    <Pagination className={cn("py-4", className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationLink
            href="#"
            size="default"
            aria-label={"Previous"}
            aria-disabled={!canPrev}
            className={cn("gap-1 px-2.5", !canPrev && "pointer-events-none opacity-50")}
            onClick={(e) => {
              e.preventDefault();
              if (canPrev) onPageChange(page - 1);
            }}
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:block">{"Previous"}</span>
          </PaginationLink>
        </PaginationItem>

        <PaginationItem>
          <span className="px-3 text-sm text-muted-foreground">
            {"Page"} {page} / {totalPages}
          </span>
        </PaginationItem>

        <PaginationItem>
          <PaginationLink
            href="#"
            size="default"
            aria-label={"Next"}
            aria-disabled={!canNext}
            className={cn("gap-1 px-2.5", !canNext && "pointer-events-none opacity-50")}
            onClick={(e) => {
              e.preventDefault();
              if (canNext) onPageChange(page + 1);
            }}
          >
            <span className="hidden sm:block">{"Next"}</span>
            <ChevronRight className="size-4" />
          </PaginationLink>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
