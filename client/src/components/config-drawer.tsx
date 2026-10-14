/* The thread's settings, as one bottom drawer on a phone.
   Selector rows open pages inside the same drawer, so nested settings never
   stack modal sheets or split focus and scrolling between overlays. */
import * as React from "react"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
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
  | { type: "label"; text: string }
  | { type: "pick"; pick: ChoicePick }
  | { type: "switch"; label: string; checked: boolean; onChange: (checked: boolean) => void }
  | { type: "action"; label: string; icon?: React.ReactNode; onClick: () => void; muted?: boolean }
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
  const reduceMotion = useReducedMotion() ?? false
  const [pageKey, setPageKey] = React.useState<string | null>(null)
  const [pageDirection, setPageDirection] = React.useState<1 | -1>(1)
  const showPage = (key: string) => {
    setPageDirection(1)
    setPageKey(key)
  }
  const showList = () => {
    setPageDirection(-1)
    setPageKey(null)
  }
  React.useEffect(() => {
    if (!open) setPageKey(null)
  }, [open])

  const list = rows.filter((row): row is DrawerRow => !!row)
  const keyOf = (row: DrawerRow) =>
    row.type === "pick" ? `pick:${row.pick.label}` : row.type === "page" ? `page:${row.label}` : ""
  const pages = list.flatMap((row) => {
    if (row.type === "pick") {
      const pick = row.pick
      return [{
        key: keyOf(row),
        title: pick.label,
        render: () => (
          <ChoiceList
            {...pick}
            onSelect={(value) => {
              showList()
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
      }]
    }
    if (row.type === "page") {
      return [{ key: keyOf(row), title: row.label, render: () => <div className="pb-2">{row.content}</div> }]
    }
    return []
  })
  const page = pages.find((candidate) => candidate.key === pageKey)

  React.useEffect(() => {
    if (pageKey && !page) setPageKey(null)
  }, [pageKey, page])

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} tall>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          {page ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Back"
                onClick={showList}
                className="-ml-2 grid size-9 shrink-0 place-items-center rounded-full hover:bg-muted"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
              <ResponsiveDialogTitle>{page.title}</ResponsiveDialogTitle>
            </div>
          ) : (
            <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
          )}
          <ResponsiveDialogDescription className="sr-only">
            {page?.title ?? "Thread settings"}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <m.div
          layout={!reduceMotion}
          transition={{ layout: { duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] } }}
          className="min-h-0"
        >
          <AnimatePresence initial={false} mode="wait" custom={pageDirection}>
            {page ? (
              <m.div
                key={page.key}
                variants={{
                  enter: (direction: 1 | -1) => ({ opacity: 0, x: reduceMotion ? 0 : direction * 36 }),
                  center: { opacity: 1, x: 0 },
                  exit: (direction: 1 | -1) => ({ opacity: 0, x: reduceMotion ? 0 : direction * -24 }),
                }}
                initial={reduceMotion ? false : "enter"}
                animate="center"
                exit="exit"
                transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="pb-2"
              >
                {page.render()}
              </m.div>
            ) : (
              <m.div
                key="settings-list"
                variants={{
                  enter: (direction: 1 | -1) => ({ opacity: 0, x: reduceMotion ? 0 : direction * 36 }),
                  center: { opacity: 1, x: 0 },
                  exit: (direction: 1 | -1) => ({ opacity: 0, x: reduceMotion ? 0 : direction * -24 }),
                }}
                initial={reduceMotion ? false : "enter"}
                animate="center"
                exit="exit"
                transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col pb-2"
              >
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
              const current = isPick ? row.pick.choices.find((choice) => choice.value === row.pick.value) : undefined
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => showPage(keyOf(row))}
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
              </m.div>
            )}
          </AnimatePresence>
        </m.div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
