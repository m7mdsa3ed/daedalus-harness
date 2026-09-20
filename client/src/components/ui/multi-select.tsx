import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

/** Upper bound on rendered rows; the rest are reachable through the search box. */
const MAX_RENDERED_OPTIONS = 100;

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  maxDisplay?: number;
  className?: string;
}

export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select items...",
  searchPlaceholder = "Search...",
  emptyMessage = "No items found.",
  maxDisplay = 2,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);

  const handleSelect = (value: string) => {
    const newSelected = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
    onChange(newSelected);
  };

  const handleRemove = (value: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selected.filter((item) => item !== value));
  };

  // Map lookup, not `options.find` per selected value: these lists are
  // unpaginated (`getAll` categories/contacts/tags), so the naive version was
  // O(selected x options) on every render of the filters panel.
  const labelByValue = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const opt of options) map.set(opt.value, opt.label);
    return map;
  }, [options]);

  const selectedLabels = React.useMemo(
    () => selected.map((value) => labelByValue.get(value)).filter(Boolean),
    [selected, labelByValue],
  );

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);

  // Filtering is ours, not cmdk's: cmdk can only match what is rendered, and we
  // deliberately don't render every option. Unbounded lists (all contacts, all
  // categories) would otherwise mount thousands of CommandItems into a 300px
  // scroller — the single biggest cost of opening the mobile filters panel.
  const [query, setQuery] = React.useState("");
  const filteredOptions = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(q));
  }, [options, query]);

  const visibleOptions = React.useMemo(
    () => (filteredOptions.length > MAX_RENDERED_OPTIONS ? filteredOptions.slice(0, MAX_RENDERED_OPTIONS) : filteredOptions),
    [filteredOptions],
  );
  const hiddenCount = filteredOptions.length - visibleOptions.length;

  // Reset the search when the list closes so the next open starts clean.
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between min-h-9 h-auto", className)} />}>
          <div className="flex gap-1 flex-1 min-w-0">
            {selected.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              <div className="flex items-center gap-1 flex-wrap max-w-full">
                {selectedLabels.slice(0, maxDisplay).map((label, index) => {
                  const value = selected[index];
                  return (
                    <Badge
                      key={value}
                      variant="secondary"
                      className="text-xs px-2 py-0 h-5 flex items-center gap-1"
                    >
                      <span className="truncate max-w-[100px]">{label}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Remove ${label}`}
                        className="ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 cursor-pointer"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            handleRemove(value, e as any);
                          }
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => handleRemove(value, e)}
                      >
                        <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                      </span>
                    </Badge>
                  );
                })}
                {selected.length > maxDisplay && (
                  <Badge variant="secondary" className="text-xs px-2 py-0 h-5">
                    +{selected.length - maxDisplay}
                  </Badge>
                )}
              </div>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList className="max-h-[300px]">
            {/* Plain node, not CommandEmpty: with `shouldFilter={false}` cmdk
                no longer owns the empty state, we do. */}
            {filteredOptions.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
            )}
            <CommandGroup>
              {visibleOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => handleSelect(option.value)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      selectedSet.has(option.value) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
              {hiddenCount > 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  +{hiddenCount} more — type to search
                </div>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
