import * as React from "react"
import { Folder, FileIcon, AtSign } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api, type FsListing, type ServerSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

/*
 * A text input with a suggestion popup. Two faces of one core:
 *
 *   - PathInput — the whole value is the query; suggestions come from the
 *     server's filesystem (`GET /api/fs/list`), picking a directory drills in.
 *   - MentionInput — only the token under the caret (after a trigger char,
 *     "@" by default) is the query; picking replaces that token. This is the
 *     mention-ready shape a future composer can mount directly.
 *
 * The popup is NOT a portal: it renders absolutely inside a relative wrapper,
 * which keeps it inside whatever dialog owns the input — a document.body
 * portal would sit outside the dialog's DOM and every click on it would trip
 * the dialog's outside-press dismissal.
 */

/** One row the popup offers. `value` is what a pick puts into the input. */
export interface SuggestingItem {
  key: string
  value: string
  label: React.ReactNode
  hint?: React.ReactNode
  kind?: "dir" | "file" | "mention" | "other"
}

/** Debounced async suggestions with per-keystroke abort. `fetchItems` must be
    referentially stable (useCallback) or every render refetches. */
function useSuggestions(
  fetchItems: (query: string, signal: AbortSignal) => Promise<SuggestingItem[]>,
  query: string,
  open: boolean,
  debounceMs: number,
) {
  const [items, setItems] = React.useState<SuggestingItem[]>([])
  const [loading, setLoading] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      fetchItems(query, ctrl.signal).then(
        (next) => {
          if (ctrl.signal.aborted) return
          setItems(next)
          setLoading(false)
        },
        () => {
          if (ctrl.signal.aborted) return
          setItems([])
          setLoading(false)
        },
      )
    }, debounceMs)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [fetchItems, query, open, debounceMs])
  return { items, loading }
}

const defaultRenderItem = (item: SuggestingItem) => (
  <>
    {item.kind === "dir" ? (
      <Folder className="size-4 shrink-0 text-muted-foreground" />
    ) : item.kind === "file" ? (
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
    ) : item.kind === "mention" ? (
      <AtSign className="size-4 shrink-0 text-muted-foreground" />
    ) : null}
    <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.label}</span>
    {item.hint && <span className="shrink-0 text-[11px] text-muted-foreground">{item.hint}</span>}
  </>
)

function SuggestPopup({
  open,
  items,
  active,
  loading,
  empty,
  footer,
  renderItem = defaultRenderItem,
  onPick,
  onHover,
}: {
  open: boolean
  items: SuggestingItem[]
  active: number
  loading: boolean
  empty: React.ReactNode
  footer?: React.ReactNode
  renderItem?: (item: SuggestingItem, state: { active: boolean }) => React.ReactNode
  onPick: (item: SuggestingItem) => void
  onHover: (index: number) => void
}) {
  const listRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [active])
  if (!open) return null
  return (
    <div
      className="absolute top-full right-0 left-0 z-30 mt-1.5 overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 duration-100 animate-in fade-in-0 zoom-in-95"
      // Keep focus (and the popup) alive while clicking a row.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={listRef} className="max-h-64 overflow-y-auto overscroll-contain p-1" role="listbox">
        {items.map((item, index) => (
          <div
            key={item.key}
            role="option"
            aria-selected={index === active}
            data-active={index === active}
            className={cn(
              "flex cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-sm select-none",
              index === active && "bg-accent text-accent-foreground",
            )}
            onClick={() => onPick(item)}
            onMouseMove={() => onHover(index)}
          >
            {renderItem(item, { active: index === active })}
          </div>
        ))}
        {items.length === 0 && (
          <div className="px-3 py-2 text-sm text-muted-foreground">{loading ? "Loading…" : empty}</div>
        )}
      </div>
      {footer && (
        <div className="border-t border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">{footer}</div>
      )}
    </div>
  )
}

/** Arrow/Enter/Escape handling shared by both faces. Enter only commits after
    the user has highlighted a row — an untouched popup must not steal the
    Enter that submits the surrounding form. */
function suggestKeyDown(opts: {
  open: boolean
  count: number
  active: number
  setActive: (index: number) => void
  commit: (index: number) => void
  close: () => void
  openUp: () => void
}) {
  return (e: React.KeyboardEvent) => {
    if (!opts.open) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        opts.openUp()
      }
      return
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        if (opts.count > 0) opts.setActive((opts.active + 1) % opts.count)
        break
      case "ArrowUp":
        e.preventDefault()
        if (opts.count > 0) opts.setActive(opts.active <= 0 ? opts.count - 1 : opts.active - 1)
        break
      case "Enter":
      case "Tab":
        if (opts.active >= 0 && opts.active < opts.count) {
          e.preventDefault()
          opts.commit(opts.active)
        }
        break
      case "Escape":
        // The popup consumes this Escape; it must not also close the dialog.
        e.preventDefault()
        e.stopPropagation()
        opts.close()
        break
    }
  }
}

/** "/home/me/pro" -> list "/home/me/", filter by "pro". "" lists $HOME. */
function splitPath(value: string): { dir: string; prefix: string } {
  const v = value.trim()
  const at = v.lastIndexOf("/")
  if (at === -1) return { dir: "", prefix: v }
  return { dir: v.slice(0, at + 1), prefix: v.slice(at + 1) }
}

/**
 * Server-side path autocomplete. The value is a directory on the harness
 * server; suggestions are that directory's children, and picking one appends a
 * trailing "/" so the next listing drills straight in.
 */
export function PathInput({
  value,
  onValueChange,
  settings,
  dirsOnly = true,
  className,
  ...inputProps
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
  value: string
  onValueChange: (next: string) => void
  settings: ServerSettings
  /** Files are noise when picking a working directory. */
  dirsOnly?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(-1)

  const fetchItems = React.useCallback(
    async (query: string, signal: AbortSignal) => {
      const { dir, prefix } = splitPath(query)
      const listing = await api<FsListing>(
        settings,
        `/api/fs/list?path=${encodeURIComponent(dir)}`,
        { signal },
      )
      const base = listing.cwd.endsWith("/") ? listing.cwd : `${listing.cwd}/`
      const lower = prefix.toLowerCase()
      return listing.entries
        .filter(
          (entry) =>
            (!dirsOnly || entry.type === "dir") &&
            // Hidden entries only surface once the user asks by typing the dot.
            (entry.name.startsWith(".") ? prefix.startsWith(".") : true) &&
            entry.name.toLowerCase().startsWith(lower),
        )
        .map((entry) => ({
          key: base + entry.name,
          value: base + entry.name + (entry.type === "dir" ? "/" : ""),
          label: entry.name,
          kind: entry.type,
        }))
    },
    [settings, dirsOnly],
  )

  const { items, loading } = useSuggestions(fetchItems, value, open, 150)

  const close = () => {
    setOpen(false)
    setActive(-1)
  }
  const commit = (index: number) => {
    const item = items[index]
    if (!item) return
    onValueChange(item.value)
    setActive(-1) // stay open — a picked directory lists its own children next
  }

  return (
    <div className="relative">
      <Input
        {...inputProps}
        value={value}
        className={cn("font-mono text-xs", className)}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        onChange={(e) => {
          onValueChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onKeyDown={suggestKeyDown({
          open,
          count: items.length,
          active,
          setActive,
          commit,
          close,
          openUp: () => setOpen(true),
        })}
      />
      <SuggestPopup
        open={open}
        items={items}
        active={active}
        loading={loading}
        empty={value.trim() === "" ? "Type a path on the server." : "Nothing here."}
        footer={value.trim() === "" ? "Listing the server's home directory." : undefined}
        onPick={(item) => commit(items.indexOf(item))}
        onHover={setActive}
      />
    </div>
  )
}

/**
 * Mention-style autocomplete: the token under the caret that starts with
 * `trigger` is the query, and a pick replaces exactly that token. No caller
 * yet — this is the composer-facing face of the primitive, kept alive so the
 * core stays generic.
 */
export function MentionInput({
  value,
  onValueChange,
  items: fetchItems,
  trigger = "@",
  multiline = false,
  renderItem,
  empty = "No matches.",
  className,
  ...inputProps
}: Omit<React.ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string
  onValueChange: (next: string) => void
  items: (query: string, signal: AbortSignal) => Promise<SuggestingItem[]>
  trigger?: string
  multiline?: boolean
  renderItem?: (item: SuggestingItem, state: { active: boolean }) => React.ReactNode
  empty?: React.ReactNode
}) {
  const elementRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [token, setToken] = React.useState<{ start: number; end: number; query: string } | null>(null)
  const [active, setActive] = React.useState(-1)

  /** The token under the caret, or null — whitespace or a missing trigger ends
      it. Reads the element's own text: inside the post-change rAF the `value`
      prop is still the previous render's. */
  const findToken = () => {
    const el = elementRef.current
    if (!el) return null
    const caret = el.selectionStart ?? 0
    const before = el.value.slice(0, caret)
    const at = before.lastIndexOf(trigger)
    if (at === -1) return null
    if (at > 0 && !/\s/.test(before[at - 1])) return null
    const query = before.slice(at + trigger.length)
    if (/\s/.test(query)) return null
    return { start: at, end: caret, query }
  }
  const refresh = () => {
    setToken(findToken())
    setActive(-1)
  }

  const open = token !== null
  const { items, loading } = useSuggestions(fetchItems, token?.query ?? "", open, 50)

  const commit = (index: number) => {
    const item = items[index]
    const el = elementRef.current
    if (!item || !token || !el) return
    const inserted = trigger + item.value + " "
    onValueChange(value.slice(0, token.start) + inserted + value.slice(token.end))
    setToken(null)
    setActive(-1)
    const caret = token.start + inserted.length
    requestAnimationFrame(() => el.setSelectionRange(caret, caret))
  }

  const keyDown = suggestKeyDown({
    open,
    count: items.length,
    active,
    setActive,
    commit,
    close: () => setToken(null),
    openUp: refresh,
  })

  const shared = {
    ...inputProps,
    value,
    className: cn(className),
    autoComplete: "off",
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onValueChange(e.target.value)
      // The new value lands in state next render; token detection reads the
      // element's own text, which is already current.
      requestAnimationFrame(refresh)
    },
    onKeyDown: keyDown,
    onClick: refresh,
    onBlur: () => setToken(null),
  }

  return (
    <div className="relative">
      {multiline ? (
        <Textarea {...(shared as React.ComponentProps<"textarea">)} ref={elementRef as React.Ref<HTMLTextAreaElement>} />
      ) : (
        <Input {...(shared as React.ComponentProps<"input">)} ref={elementRef as React.Ref<HTMLInputElement>} />
      )}
      <SuggestPopup
        open={open}
        items={items}
        active={active}
        loading={loading}
        empty={empty}
        renderItem={renderItem}
        onPick={(item) => commit(items.indexOf(item))}
        onHover={setActive}
      />
    </div>
  )
}
