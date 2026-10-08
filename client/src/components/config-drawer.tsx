/* ── The thread's settings, as one bottom drawer on a phone ──
   The desktop menu is a dropdown with a flyout per row. On a phone that is a
   menu of nested menus, and a thumb cannot hit the second level reliably — so
   the *whole* menu is a drawer instead (`ResponsiveDialog`'s bottom drawer: grab handle,
   swipe to dismiss, one scroll region for the body): a list of rows, and a row that picks
   from many opens its choices as the next page of the same drawer (a back arrow
   up top), never a second overlay stacked on the first.

   It is data-driven: the caller (`SessionConfigPopover`, `DraftConfigPopover`)
   builds the same rows it draws in the dropdown and hands them over, so the two
   renderings are one list of settings and cannot drift. */
import * as React from "react"
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react"

import { ChoiceList, type ChoicePick } from "@/components/config-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

export type DrawerRow =
  /** A section heading. */
  | { type: "label"; text: string }
  /** A setting that chooses from a list: its value on the row, the list as the next page. */
  | { type: "pick"; pick: ChoicePick }
  /** An on/off setting. */
  | { type: "switch"; label: string; checked: boolean; onChange: (checked: boolean) => void }
  /** A button. */
  | { type: "action"; label: string; icon?: React.ReactNode; onClick: () => void; muted?: boolean }
  /** A row whose page is arbitrary content — the tool lists. */
  | { type: "page"; label: string; icon?: React.ReactNode; value?: string; content: React.ReactNode }

/** What a caller builds: rows, with `false`/`null` for the ones a condition drops. */
export type DrawerRows = (DrawerRow | false | null | undefined)[]


export function ConfigDrawer({
  open,
  onOpenChange,
  title,
  rows,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  rows: DrawerRows
}) {
  /* The page that is open, by key. A page is its own drawer, opened from the
     rows' one — slid up over it with the drawer's own animation and closed by
     the same swipe — rather than the rows being swapped out for it. Held as a
     key into the rows, not as rendered nodes: a pick made on a page changes the
     rows, and the page must read the new value, not the one it opened with. */
  const [pageKey, setPageKey] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!open) setPageKey(null)
  }, [open])

  const list = rows.filter((row): row is DrawerRow => !!row)
  const keyOf = (row: DrawerRow) =>
    row.type === "pick" ? `pick:${row.pick.label}` : row.type === "page" ? `page:${row.label}` : ""
  const pages: { key: string; title: string; render: () => React.ReactNode }[] = list.flatMap((row) => {
    if (row.type === "pick") {
      const pick = row.pick
      return {
        key: keyOf(row),
        title: pick.label,
        render: () => (
          <ChoiceList
            {...pick}
            onSelect={(value) => {
              setPageKey(null)
              pick.onSelect(value)
            }}
            add={
              pick.add && {
                ...pick.add,
                onSelect: () => {
                  onOpenChange(false)
                  pick.add!.onSelect()
                },
              }
            }
          />
        ),
      }
    }
    if (row.type === "page") {
      return { key: keyOf(row), title: row.label, render: () => <div className="pb-2">{row.content}</div> }
    }
    return []
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} tall>
      <ResponsiveDialogContent>
        {/* The header and the body are the only two children, so the dialog's
            layout invariant holds: the header stays put, the body is the one
            region that scrolls — pages inside it never scroll on their own. */}
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">Thread settings</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {(
          <div className="flex flex-col pb-2">
            {list.map((row, i) => {
              if (row.type === "label") {
                return (
                  <div key={i} className="px-2 pt-4 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                    {row.text}
                  </div>
                )
              }
              if (row.type === "switch") {
                return (
                  <label key={i} className="flex min-h-12 items-center gap-3 rounded-lg px-2 text-sm">
                    <span className="flex-1">{row.label}</span>
                    <Switch checked={row.checked} onCheckedChange={row.onChange} aria-label={row.label} />
                  </label>
                )
              }
              if (row.type === "action") {
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={row.onClick}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-muted",
                      row.muted && "text-muted-foreground"
                    )}
                  >
                    {row.icon}
                    {row.label}
                  </button>
                )
              }
              const isPick = row.type === "pick"
              const current = isPick ? row.pick.choices.find((c) => c.value === row.pick.value) : undefined
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPageKey(keyOf(row))}
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-sm hover:bg-muted"
                >
                  {isPick ? current?.icon : row.icon}
                  <span className="flex-1">{isPick ? row.pick.label : row.label}</span>
                  <span className="max-w-32 truncate text-xs text-muted-foreground">
                    {isPick ? (current?.name ?? row.pick.value) : row.value}
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
              )
            })}
          </div>
        )}
        {/* Each page is a drawer of its own, nested in this one's tree so the
            drawer primitive stacks it over this one. Closed ones render
            nothing. */}
        {pages.map((page) => (
          <ResponsiveDialog
            key={page.key}
            open={pageKey === page.key}
            onOpenChange={(next) => !next && setPageKey((current) => (current === page.key ? null : current))}
            tall
          >
            <ResponsiveDialogContent>
              <ResponsiveDialogHeader>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Back"
                    onClick={() => setPageKey(null)}
                    className="-ml-2 grid size-9 shrink-0 place-items-center rounded-full hover:bg-muted"
                  >
                    <ArrowLeftIcon className="size-4" />
                  </button>
                  <ResponsiveDialogTitle>{page.title}</ResponsiveDialogTitle>
                </div>
                <ResponsiveDialogDescription className="sr-only">{page.title}</ResponsiveDialogDescription>
              </ResponsiveDialogHeader>
              {page.render()}
            </ResponsiveDialogContent>
          </ResponsiveDialog>
        ))}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
