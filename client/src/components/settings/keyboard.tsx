/* ── Settings › Keyboard ──
   Every binding the app has, on one page, with the two things a rebinding
   actually needs: a chord, and an answer to "and what about whatever else
   wanted that key".

   The list is `SHORTCUTS` itself, never a second table — a key that stops being
   bound disappears from here on its own, which is the rule the help sheet was
   already written to. Rows that are not `rebindable` are still listed: Enter
   sends and Escape backs out, and a page of shortcuts that quietly omitted them
   would read as an incomplete list rather than as a deliberate one.

   The recorder is a dialog rather than an input that listens in place, because
   while it is recording *every* chord belongs to it — ⌘K must be captured, not
   open the palette — and a dialog is the one surface where "the whole keyboard
   is mine for a moment" is legible. It captures on keydown at the capture phase
   for the same reason.

   Warnings are shown before the chord is saved and again on the row afterwards,
   because the two questions differ: choosing is "do you want this", living with
   it is "why is this one not firing". */
import * as React from "react"
import {
  AlertTriangleIcon,
  InfoIcon,
  KeyboardIcon,
  LockIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react"

import { Shortcut } from "@/components/shortcut"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Switch } from "@/components/ui/switch"
import { useConfirm } from "@/components/confirm-dialog"
import {
  chordWarnings,
  isCustomized,
  resetAllShortcuts,
  resetShortcut,
  setShortcutChords,
  setShortcutOverride,
  useKeybindings,
  type ChordWarning,
} from "@/lib/keybindings"
import {
  chordFromEvent,
  formatChord,
  reservedChord,
  SHORTCUTS,
  SHORTCUT_SCOPES,
  type ShortcutDef,
  type ShortcutId,
} from "@/lib/shortcuts"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { CopyButton } from "@/components/ui/copy-button"
import { Notice } from "@/components/notice"
import { QUICK_ENTRY_DEFAULT, useQuickEntry } from "@/lib/desktop"
import { DataTable, TitleCell, type DataTableSort, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
import { Group, INSET, PageHeader, Row, Section, StatusBadge } from "./primitives"
import { sectionMeta } from "./sections"

/** The desktop shell is the one place a browser-reserved chord is free: the
    page is the whole window, so nothing above it claims ⌘N first. */
const DESKTOP = typeof window !== "undefined" && !!window.desktop?.isElectron

function WarningLine({ warning }: { warning: ChordWarning }) {
  const hard = warning.kind === "hard"
  // A span, not a p: these are rendered inside Row's `subtitle`, which is
  // already inside a block of text.
  return (
    <span
      className={cn(
        "flex items-start gap-1.5 text-[11px] leading-snug",
        hard ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {hard ? (
        <AlertTriangleIcon className="mt-px size-3 shrink-0" />
      ) : (
        <InfoIcon className="mt-px size-3 shrink-0" />
      )}
      <span className="text-pretty">{warning.text}</span>
    </span>
  )
}

/** One shortcut, with everything a column needs already worked out — the cells
    close over nothing, so the table's per-row memo holds until a binding
    actually moves. */
interface ShortcutRowData {
  id: ShortcutId
  def: ShortcutDef
  chords: string[]
  override: boolean
  rebindable: boolean
  custom: boolean
  reserved: ReturnType<typeof reservedChord>
  warnings: ChordWarning[]
}

/** Alternatives read as alternatives, the way the help sheet prints them. */
function Chords({ def, chords }: { def: ShortcutDef; chords: string[] }) {
  if (def.display) return <Shortcut keys={def.display} />
  if (chords.length === 0) return <span className="text-xs text-muted-foreground">Not bound</span>
  return (
    <>
      {chords.map((chord, index) => (
        <React.Fragment key={chord}>
          {index > 0 && <span className="text-[11px] text-muted-foreground">or</span>}
          <Shortcut chord={chord} />
        </React.Fragment>
      ))}
    </>
  )
}

/** The row's standing complaint: a mark that says "something else wants this
    key", with the words on hover and in the recorder. */
function WarnMark({ warnings }: { warnings: ChordWarning[] }) {
  if (warnings.length === 0) return null
  const hard = warnings.some((warning) => warning.kind === "hard")
  return (
    <span
      role="img"
      aria-label={warnings.map((warning) => warning.text).join(" ")}
      title={warnings.map((warning) => warning.text).join(" ")}
      className={cn("shrink-0", hard ? "text-destructive" : "text-muted-foreground")}
    >
      <AlertTriangleIcon className="size-3.5" />
    </span>
  )
}

/** The recorder. Open, press the chord, read what it will cost, save. It also
    carries what the table has no room for on a phone: the binding as it stands,
    its warnings, and the Override switch for a chord something else wants. */
function RecordDialog({
  shortcut,
  open,
  onOpenChange,
}: {
  shortcut: ShortcutDef | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const bindings = useKeybindings()
  const [chord, setChord] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) setChord(null)
  }, [open, shortcut?.id])

  /* Capture phase on the window: while this is open the keyboard belongs to the
     recorder, so a chord the app itself binds is written down rather than
     obeyed. Escape and Tab are the two exceptions — leaving and moving focus
     have to keep working, or a recorder opened by accident is a trap. */
  React.useEffect(() => {
    if (!open || !shortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") return
      event.preventDefault()
      event.stopPropagation()
      const next = chordFromEvent(event)
      if (next) setChord(next)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [open, shortcut])

  if (!shortcut) return null
  const warnings = chord ? chordWarnings(chord, shortcut.id, DESKTOP) : []
  const live = bindings[shortcut.id]
  const liveWarnings = live.chords.flatMap((entry) => chordWarnings(entry, shortcut.id, DESKTOP))
  const liveReserved = live.chords.map((entry) => reservedChord(entry)).find(Boolean)

  const save = () => {
    if (!chord) return
    setShortcutChords(shortcut.id, [chord])
    onOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{shortcut.label}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {shortcut.note ? `${shortcut.note} ` : ""}Press the keys you want. Escape closes this without
            changing anything.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="pb-2">
          <div
            className={cn(
              "flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border border-dashed",
              chord ? "border-primary/40 bg-primary/5" : "bg-muted/30"
            )}
          >
            {chord ? (
              <Shortcut chord={chord} keyClassName="h-7 min-w-7 text-sm" />
            ) : (
              <p className="text-xs text-muted-foreground">Waiting for a key…</p>
            )}
          </div>
          {warnings.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {warnings.map((warning) => (
                <WarningLine key={warning.kind + warning.text} warning={warning} />
              ))}
            </div>
          )}
          <div className={cn(INSET, "mt-4 space-y-2 p-3")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Now</span>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                <Chords def={shortcut} chords={live.chords} />
              </div>
            </div>
            {liveWarnings.map((warning) => (
              <WarningLine key={warning.kind + warning.text} warning={warning} />
            ))}
            {/* Only offered where something else wants the key: elsewhere there
                is nothing to override and a switch would be a question with one
                answer. A hard-reserved chord is not overridable at all — the page
                never receives it — so the switch says so by being disabled. */}
            {liveReserved && (
              <label className="flex min-h-9 items-center justify-between gap-3 text-xs pointer-coarse:min-h-11">
                <span>Override the other use of this key</span>
                <Switch
                  checked={live.override && liveReserved.reserved !== "hard"}
                  disabled={liveReserved.reserved === "hard"}
                  onCheckedChange={(value) => setShortcutOverride(shortcut.id, value)}
                />
              </label>
            )}
          </div>
        </div>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!chord} onClick={save}>
            Use this chord
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/** What a row's binding is, in words: the Source column on a table, the second
    word of the meta line on a phone. */
function sourceLabel(row: ShortcutRowData): string {
  if (!row.rebindable) return "Fixed"
  const key = row.reserved ? (row.reserved.reserved === "hard" ? "Browser key" : "Shared key") : null
  if (key) return row.custom ? `Customized · ${key}` : key
  return row.custom ? "Customized" : "Default"
}

const SOURCES = [
  { value: "all", label: "All" },
  { value: "customized", label: "Custom" },
  { value: "reserved", label: "Reserved" },
  { value: "fixed", label: "Fixed" },
]

const SOURCE_TEST: Record<string, (row: ShortcutRowData) => boolean> = {
  all: () => true,
  customized: (row) => row.custom,
  reserved: (row) => !!row.reserved,
  fixed: (row) => !row.rebindable,
}

const FILTER_FIELDS = [
  {
    id: "scope",
    label: "Category",
    type: "multi-select" as const,
    options: SHORTCUT_SCOPES.map((name) => ({ value: name, label: name })),
  },
  { id: "source", label: "Source", type: "segmented" as const, options: SOURCES },
]

const markOf = (row: ShortcutRowData) => (row.rebindable ? <KeyboardIcon /> : <LockIcon />)

const COLUMNS: ColumnDef<ShortcutRowData, unknown>[] = [
  {
    id: "action",
    header: "Action",
    accessorFn: (row) => row.def.label,
    cell: ({ row }) => <TitleCell title={row.original.def.label} subtitle={row.original.def.note} />,
    meta: { title: true, className: "min-w-56" },
  },
  {
    id: "scope",
    header: "Category",
    accessorFn: (row) => row.def.scope,
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.def.scope}</span>,
    meta: { className: "hidden w-28 @panel-md:table-cell" },
  },
  {
    id: "shortcut",
    header: "Shortcut",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chords def={row.original.def} chords={row.original.chords} />
        <WarnMark warnings={row.original.warnings} />
      </div>
    ),
    meta: { className: "min-w-44" },
  },
  {
    id: "source",
    header: "Source",
    enableSorting: false,
    cell: ({ row }) => {
      const data = row.original
      return (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {!data.rebindable ? (
            <StatusBadge>Fixed</StatusBadge>
          ) : data.custom ? (
            <StatusBadge tone="info">Customized</StatusBadge>
          ) : (
            <StatusBadge dot={false}>Default</StatusBadge>
          )}
          {data.reserved && (
            <StatusBadge tone={data.reserved.reserved === "hard" ? "bad" : "warn"}>
              {data.reserved.reserved === "hard" ? "Browser key" : "Shared key"}
            </StatusBadge>
          )}
        </div>
      )
    },
    meta: { align: "end", className: "w-44" },
  },
]

/** Rebind and Reset are the whole vocabulary. On a phone the first is the left
    swipe rail and the second the right; both are in the row's menu too. */
const rowActions = (record: (id: ShortcutId) => void): TableAction<ShortcutRowData>[] => [
  {
    id: "rebind",
    label: "Rebind",
    icon: <PencilIcon />,
    position: "left",
    hidden: (row) => !row.rebindable,
    onClick: (row) => record(row.id),
  },
  {
    id: "reset",
    label: "Reset to the default",
    icon: <RotateCcwIcon />,
    hidden: (row) => !row.rebindable,
    disabled: (row) => !row.custom,
    onClick: (row) => resetShortcut(row.id),
  },
]

/** The phone row: [mark] action over category and source, keycaps at the end. */
function renderPhoneRow(row: ShortcutRowData) {
  const status = sourceLabel(row)
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {markOf(row)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.def.label}</div>
        <div className="truncate text-xs text-muted-foreground">
          {row.def.scope}
          {status !== "Default" && ` · ${status}`}
        </div>
        {row.def.note && <div className="line-clamp-2 text-xs text-muted-foreground/80">{row.def.note}</div>}
      </div>
      <div className="flex max-w-[50%] shrink-0 flex-wrap items-center justify-end gap-1">
        <WarnMark warnings={row.warnings} />
        <Chords def={row.def} chords={row.chords} />
      </div>
    </div>
  )
}

const groupHeader = (counts: Record<string, number>) => (key: string) => (
  <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
    <span>{key}</span>
    <span className="font-normal tabular-nums">{counts[key] ?? 0}</span>
  </div>
)

/** The desktop shell's one system-wide key: bring the app forward on a new
    thread from anywhere (lib/desktop.ts). An Electron accelerator, not one of
    the app's chords — the OS holds it — so it is typed, not recorded. */
function QuickEntryGroup() {
  const quick = useQuickEntry()
  const [value, setValue] = React.useState(quick.accelerator)
  const [saving, setSaving] = React.useState(false)
  const save = async (next: string) => {
    setSaving(true)
    await quick.set(next)
    setSaving(false)
  }
  return (
    <Group label="Desktop" hint="System-wide">
      <Row
        icon={KeyboardIcon}
        title="Quick entry"
        subtitle={`Starts a new thread from any application. An Electron accelerator such as ${QUICK_ENTRY_DEFAULT} or CommandOrControl+Shift+Space; empty turns it off.`}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save(value)
          }}
        >
          <Input
            aria-label="Quick entry shortcut"
            className="h-11 w-40 min-w-0 font-mono text-xs @panel-sm:h-9 @panel-sm:w-48"
            value={value}
            placeholder="Off"
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            className="h-11 @panel-sm:h-9"
            disabled={saving || value.trim() === quick.accelerator}
          >
            Save
          </Button>
        </form>
      </Row>
      {quick.error && (
        <div className="py-3">
          <Notice tone="error" action={<CopyButton text={quick.error} />}>
            {quick.error}
          </Notice>
        </div>
      )}
    </Group>
  )
}

export function KeyboardPage() {
  const meta = sectionMeta("keyboard")
  const bindings = useKeybindings()
  const confirm = useConfirm()
  const [recording, setRecording] = React.useState<ShortcutId | null>(null)
  const [query, setQuery] = React.useState("")
  const [scopes, setScopes] = React.useState<string[]>([])
  const [source, setSource] = React.useState("all")
  const [sort, setSort] = React.useState<DataTableSort | null>(null)
  const target = SHORTCUTS.find((entry) => entry.id === recording) ?? null

  const all = React.useMemo<ShortcutRowData[]>(
    () =>
      SHORTCUTS.map((def) => {
        const chords = bindings[def.id].chords
        const rebindable = def.rebindable === true
        return {
          id: def.id,
          def,
          chords,
          override: bindings[def.id].override,
          rebindable,
          custom: isCustomized(def.id),
          reserved: chords.map((chord) => reservedChord(chord)).find(Boolean),
          warnings: rebindable ? chords.flatMap((chord) => chordWarnings(chord, def.id, DESKTOP)) : [],
        }
      }),
    [bindings]
  )
  const customCount = all.filter((row) => row.custom).length
  const anyCustom = customCount > 0

  const resetAll = async () => {
    const ok = await confirm({
      title: "Reset every shortcut?",
      description: "Every chord goes back to what this release ships with, on this device.",
      confirmLabel: "Reset",
    })
    if (ok) resetAllShortcuts()
  }

  /* The search reads what the reader sees: the label, the note, the scope and
     the chord as it prints (⌘K, not mod+k). Rows are ordered here, not by the
     table: a sort moves the groups (Category) or the rows inside them (Action),
     and never interleaves them, which a table-side sort would. */
  const needle = query.trim().toLowerCase()
  const rows = React.useMemo(() => {
    const test = SOURCE_TEST[source] ?? SOURCE_TEST.all
    const order = sort?.id === "scope" && sort.desc ? [...SHORTCUT_SCOPES].reverse() : SHORTCUT_SCOPES
    return order.flatMap((name) => {
      if (scopes.length && !scopes.includes(name)) return []
      const list = all.filter(
        (row) =>
          row.def.scope === name &&
          test(row) &&
          (!needle ||
            [
              row.def.label,
              row.def.note ?? "",
              row.def.scope,
              ...row.chords.map((chord) => `${chord} ${formatChord(chord)}`),
              ...(row.def.display ?? []),
            ]
              .join(" ")
              .toLowerCase()
              .includes(needle))
      )
      if (sort?.id === "action") {
        list.sort((a, b) => a.def.label.localeCompare(b.def.label) * (sort.desc ? -1 : 1))
      }
      return list
    })
  }, [all, needle, scopes, source, sort])

  const counts = React.useMemo(() => {
    const out: Record<string, number> = {}
    for (const row of rows) out[row.def.scope] = (out[row.def.scope] ?? 0) + 1
    return out
  }, [rows])

  const actions = React.useMemo(() => rowActions(setRecording), [])
  const grouping = React.useMemo(
    () => ({
      by: (row: ShortcutRowData) => row.def.scope,
      renderHeader: groupHeader(counts),
      renderMobileHeader: groupHeader(counts),
    }),
    [counts]
  )
  const mobile = React.useMemo(() => ({ renderRow: renderPhoneRow }), [])

  const filterCount = (scopes.length ? 1 : 0) + (source !== "all" ? 1 : 0)
  const clearFilters = () => {
    setQuery("")
    setScopes([])
    setSource("all")
  }

  return (
    <>
      <PageHeader meta={meta} />
      <DataTable
        columns={COLUMNS}
        data={rows}
        getRowId={(row) => row.id}
        mark={markOf}
        actions={actions}
        grouping={grouping}
        mobile={mobile}
        manualSorting
        sorting={sort}
        onSortingChange={setSort}
        pageSize={SHORTCUTS.length}
        hidePageSize
        maxHeight="min(70dvh, 52rem)"
        emptyIcon={<SearchIcon />}
        emptyMessage={needle ? `No shortcut matches “${query.trim()}”.` : "No shortcuts match these filters."}
        emptyAction={
          <Button type="button" variant="outline" className="h-11 @panel-sm:h-9" onClick={clearFilters}>
            Clear filters
          </Button>
        }
        filtering={{
          search: { value: query, onChange: setQuery, placeholder: "Search by action or key…" },
          fields: FILTER_FIELDS,
          values: { scope: scopes, source },
          onChange: (id, value) => {
            if (id === "scope") setScopes(value as string[])
            else setSource((value as string) || "all")
          },
          count: filterCount,
          onClear: () => {
            setScopes([])
            setSource("all")
          },
          totalCount: SHORTCUTS.length,
        }}
        toolbar={
          <Button
            type="button"
            variant="outline"
            className="h-11 @panel-sm:h-9"
            disabled={!anyCustom}
            title={anyCustom ? `${customCount} customized` : "Nothing is customized"}
            onClick={() => void resetAll()}
          >
            <RotateCcwIcon />
            Reset all
          </Button>
        }
      />
      {window.desktop?.setQuickEntry && <QuickEntryGroup />}
      <Section>
        <Notice size="md" icon={<KeyboardIcon className="size-4" />}>
          Shortcuts are stored on this device and never synced.{" "}
          {DESKTOP
            ? "In the desktop app the page receives every chord the operating system does not take first, so a binding here wins over the browser defaults it names."
            : `In a browser tab a few chords never reach the page at all — ${formatChord(
                "mod+n"
              )}, ${formatChord("mod+t")}, ${formatChord(
                "mod+w"
              )} and the like are the browser's own and can only be taken back by the installed desktop app. The rest are yours as long as "Override" is on.`}
        </Notice>
      </Section>
      <RecordDialog
        shortcut={target}
        open={recording !== null}
        onOpenChange={(open) => !open && setRecording(null)}
      />
    </>
  )
}
