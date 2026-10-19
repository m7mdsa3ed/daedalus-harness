/* ── Library sections ──
   The generic list+import scaffolding the library pages (MCP servers, skills,
   commands) share. Not a route of its own.

   Layout: one DataTable. Name (mark, name over its mono handle) | the
   description | small facts (source, argument hint, built-in) | Edit/Delete as
   row actions. Search and Import / New live in the table's own toolbar, so on a
   phone the same rows become the continuous list (mark, name, two lines,
   chevron into the form) with Delete on the swipe rail. */
import * as React from "react"
import { Download, Pencil, Plus, Trash2 } from "lucide-react"
import { useNavigate } from "react-router"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, reportPromise, type InlineError } from "@/lib/errors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useTableFilter, type TableFilterField } from "@/lib/use-table-filter"
import { DataTable, TitleCell, type TableAction } from "@/components/ui/data-table"
import { PickerSkeleton } from "@/components/ui/skeletons"
import { useConfirm } from "@/components/confirm-dialog"
import type { ColumnDef } from "@/lib/table"
import { api, type ImportCandidates, type ServerSettings } from "@/lib/settings"
import { settingsFormPath, settingsPath } from "@/lib/router"
import {
  EmptyCard,
  FormActions,
  FormPageHeader,
  FormSection,
  FormShell,
  PageForm,
  PageHeader,
  Toolbar,
} from "./primitives"
import { type SectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

const NEW_BTN = "h-11 @panel-sm:h-9"

/** Library registry: a table of entries with create / edit / delete. */
export function LibrarySection<T extends { id: string; name: string }>({
  meta,
  items,
  endpoint,
  noun,
  subtitle,
  settings,
  refresh,
  extraActions,
  rowExtra,
  rowIcon,
  rowDetail,
  rowBadges,
  rowHandle,
  detailLabel = "Description",
  badgesLabel = "Details",
  editable = () => true,
  importable = true,
  renderRows,
  filterFields,
}: {
  meta: SectionMeta
  items: T[]
  endpoint: string
  noun: string
  subtitle: (item: T) => string
  settings: ServerSettings
  refresh: () => Promise<void>
  /** Section-specific buttons beside Import / New (the MCP page's built-ins). */
  extraActions?: React.ReactNode
  /** Per-row controls before Edit / Delete, drawn as a trailing column. */
  rowExtra?: (item: T) => React.ReactNode
  /** This row's own mark, where the rows of a library are not all the same
      kind of thing. Defaults to the section's icon. */
  rowIcon?: (item: T) => React.ReactNode
  /** The description column, drawn. `subtitle` stays the *string* — it is what
      search matches on — so a page that wants prose supplies both. Defaults to
      `subtitle` in monospace, right when the detail is a command or a path. */
  rowDetail?: (item: T) => React.ReactNode
  /** Small facts about a row (its source, its argument hint) as a badge column. */
  rowBadges?: (item: T) => React.ReactNode
  /** The mono line under the name: `/name`. */
  rowHandle?: (item: T) => React.ReactNode
  /** Column headings, where "Description" / "Details" are not the words. */
  detailLabel?: string
  badgesLabel?: string
  /** Whether a row gets an Edit button. Every row can still be deleted. */
  editable?: (item: T) => boolean
  /** Whether there is anything to import from. False for a library the agents'
      own configs know nothing about. */
  importable?: boolean
  /** Category filters beside the search box (a row's kind, source, scope…). */
  filterFields?: TableFilterField<T>[]
  /** Replaces the table for a library whose rows want a shape of their own
      (MCP's expandable cards). Header, actions, the empty state and the delete
      confirmation stay this component's. */
  renderRows?: (ctx: {
    items: T[]
    canEdit: (item: T) => boolean
    edit: (item: T) => void
    remove: (item: T) => void
  }) => React.ReactNode
}) {
  const navigate = useNavigate()
  const confirm = useConfirm()

  const remove = async (item: T) => {
    if (
      !(await confirm({
        title: `Delete "${item.name}"?`,
        description: `The ${noun} is removed from the library and unlinked from every profile and thread that used it. Threads already running keep it until they are restarted.`,
        destructive: true,
        confirmLabel: "Delete",
      }))
    )
      return
    try {
      await api(settings, `${endpoint}/${item.id}`, { method: "DELETE" })
      await refresh()
    } catch (err) {
      reportError(err, `Couldn't delete the ${noun}`)
    }
  }
  const edit = (item: T) => void navigate(settingsFormPath(meta.id, item.id))

  /* The callers pass inline arrows, and the table memoises its rows against the
     columns and actions — so those are built once and read the latest props
     through this ref. */
  const live = React.useRef({ subtitle, rowExtra, rowIcon, rowDetail, rowBadges, rowHandle, editable, edit, remove })
  live.current = { subtitle, rowExtra, rowIcon, rowDetail, rowBadges, rowHandle, editable, edit, remove }

  const f = useTableFilter(items, {
    text: (item) => `${item.name} ${live.current.subtitle(item)}`,
    placeholder: `Search ${noun}s…`,
    fields: filterFields,
  })

  const hasBadges = Boolean(rowBadges)
  const hasExtra = Boolean(rowExtra)
  const columns = React.useMemo<ColumnDef<T, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => {
          const item = row.original
          const handle = live.current.rowHandle?.(item)
          return (
            <TitleCell
              title={<span title={item.name}>{item.name}</span>}
              subtitle={handle ? <span className="font-mono">{handle}</span> : undefined}
            />
          )
        },
        meta: { title: true, className: "min-w-48" },
      },
      {
        id: "detail",
        header: detailLabel,
        cell: ({ row }) => {
          const item = row.original
          const detail = live.current.rowDetail?.(item)
          return detail ? (
            <div className="max-w-lg truncate text-xs text-muted-foreground">{detail}</div>
          ) : (
            <div className="max-w-lg truncate font-mono text-xs text-muted-foreground">{live.current.subtitle(item)}</div>
          )
        },
        meta: { className: "hidden @panel-md:table-cell" },
      },
      ...(hasBadges
        ? [
            {
              id: "badges",
              header: badgesLabel,
              cell: ({ row }) => <div className="flex min-w-0 flex-wrap gap-1">{live.current.rowBadges?.(row.original)}</div>,
              meta: { className: "hidden @panel-lg:table-cell" },
            } satisfies ColumnDef<T, unknown>,
          ]
        : []),
      ...(hasExtra
        ? [
            {
              id: "extra",
              header: "",
              cell: ({ row }) => <div className="flex items-center justify-end gap-1">{live.current.rowExtra?.(row.original)}</div>,
              meta: { align: "end" },
            } satisfies ColumnDef<T, unknown>,
          ]
        : []),
    ],
    [detailLabel, badgesLabel, hasBadges, hasExtra]
  )

  const actions = React.useMemo<TableAction<T>[]>(
    () => [
      {
        id: "edit",
        label: "Edit",
        icon: <Pencil className="size-4" />,
        position: "left",
        hidden: (item) => !live.current.editable(item),
        onClick: (item) => live.current.edit(item),
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 className="size-4" />,
        tone: "danger",
        position: "right",
        onClick: (item) => void live.current.remove(item),
      },
    ],
    []
  )

  const mark = React.useCallback(
    (item: T) => {
      const custom = live.current.rowIcon?.(item)
      return React.isValidElement(custom) ? custom : React.createElement(meta.icon)
    },
    [meta.icon]
  )

  const newButton = (
    <Button className={NEW_BTN} onClick={() => void navigate(settingsFormPath(meta.id))}>
      <Plus className="size-4" /> New {noun}
    </Button>
  )
  const importButton = importable ? (
    <Button variant="outline" className={NEW_BTN} onClick={() => void navigate(settingsFormPath(meta.id, "import"))}>
      <Download className="size-4" /> Import
    </Button>
  ) : null
  const emptyText = importable
    ? `No ${noun}s yet — add one, or import from the agents' own configs.`
    : `No ${noun}s yet.`

  /* A library whose rows draw themselves (MCP) keeps the page header's New and
     its own toolbar; everything else is the one table. */
  if (renderRows) {
    return (
      <>
        <PageHeader meta={meta} action={newButton} />
        {items.length === 0 ? (
          <EmptyCard
            icon={meta.icon}
            text={emptyText}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {extraActions}
                {importButton}
                {newButton}
              </div>
            }
          />
        ) : (
          <>
            <Toolbar placeholder={`Search ${noun}s…`}>
              {extraActions}
              {importButton}
            </Toolbar>
            {renderRows({ items, canEdit: editable, edit, remove: (item) => void remove(item) })}
          </>
        )}
      </>
    )
  }

  return (
    <>
      <PageHeader meta={meta} action={newButton} />
      <DataTable
        columns={columns}
        data={f.rows}
        getRowId={(item) => item.id}
        pageSize={25}
        mark={mark}
        actions={actions}
        onRowClick={(item) => {
          if (editable(item)) edit(item)
        }}
        filtering={items.length > 0 ? f.filtering : undefined}
        toolbar={
          items.length > 0 ? (
            <>
              {extraActions}
              {importButton}
            </>
          ) : undefined
        }
        emptyIcon={React.createElement(meta.icon)}
        emptyMessage={items.length === 0 ? emptyText : `Nothing matches “${f.query.trim()}”.`}
        emptyAction={
          items.length === 0 ? (
            <div className="flex flex-wrap justify-center gap-2">
              {extraActions}
              {importButton}
              {newButton}
            </div>
          ) : undefined
        }
      />
    </>
  )
}

type FoundItem = { id: string; name: string; source: string } & Record<string, unknown>

/**
 * Pick from what the agents on the server already have configured
 * (~/.claude.json, ~/.codex/config.toml, skill directories) and copy the
 * selection into the library. Entries already in the library are filtered out
 * server-side.
 */
export function LibraryImportPage({
  meta,
  kind,
  endpoint,
  noun,
  refresh,
}: {
  meta: SectionMeta
  kind: "mcpServers" | "skills" | "commands"
  endpoint: string
  noun: string
  refresh: () => Promise<void>
}) {
  const { settings } = useSettingsPage()
  const navigate = useNavigate()
  const [found, setFound] = React.useState<FoundItem[] | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  /* Drawn in place of the picker rather than toasted: the failure branch also
     sets `found` to empty, and the picker's empty line says the library
     already has everything — which is a different fact entirely. */
  const [loadError, setLoadError] = React.useState<InlineError | null>(null)

  React.useEffect(() => {
    api<ImportCandidates>(settings, "/api/import")
      .then((r) => {
        setFound(r[kind].map((item, i) => ({ ...item, id: String(i) })))
        setLoadError(null)
      })
      .catch((err) => {
        setLoadError(captureError(err, "Couldn't load what there is to import"))
        setFound([])
      })
  }, [settings, kind])

  /* One POST per selected row, in sequence — so the wait grows with the
     selection and is the kind a person starts wondering about. The promise
     toast says the import is running and then becomes its own receipt. */
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (selected.length === 0) return
    setBusy(true)
    const importAll = async () => {
      for (const id of selected) {
        const item = found?.find((f) => f.id === id)
        if (!item) continue
        const { id: _id, source: _source, ...payload } = item
        await api(settings, endpoint, { method: "POST", body: JSON.stringify(payload) })
      }
      await refresh()
    }
    void reportPromise(importAll(), {
      loading: `Importing ${selected.length} ${noun}${selected.length === 1 ? "" : "s"}…`,
      success: `Imported ${selected.length} ${noun}${selected.length === 1 ? "" : "s"}`,
      context: `Couldn't import the ${noun}s`,
    })
      .then(() => void navigate(settingsPath(meta.id)))
      .catch(() => setBusy(false))
  }

  const all = found?.map((f) => f.id) ?? []
  const selectedIds = React.useMemo(() => new Set(selected), [selected])

  const columns = React.useMemo<ColumnDef<FoundItem, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Name",
        cell: ({ row }) => <TitleCell title={<span title={row.original.name}>{row.original.name}</span>} />,
        meta: { title: true, className: "min-w-40" },
      },
      {
        id: "source",
        header: "Found in",
        cell: ({ row }) => (
          <Badge variant="secondary" className="max-w-full">
            <span className="truncate">{row.original.source}</span>
          </Badge>
        ),
      },
      {
        id: "detail",
        header: "Detail",
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="max-w-md truncate font-mono text-xs text-muted-foreground">
              {(item.url as string) ?? (item.path as string) ?? (item.command as string) ?? (item.description as string) ?? ""}
            </div>
          )
        },
        meta: { className: "hidden @panel-md:table-cell" },
      },
    ],
    []
  )
  const f = useTableFilter(found ?? [], {
    text: (i) => `${i.name} ${i.source} ${String(i.url ?? i.path ?? i.command ?? i.description ?? "")}`,
    placeholder: `Search ${noun}s…`,
    fields: [{ id: "source", label: "Found in", of: (i) => i.source }],
  })

  return (
    <>
      <FormPageHeader
        title={`Import ${noun}s`}
        description="Choose definitions already configured for agents on this server. Existing library entries are hidden."
        onBack={() => void navigate(settingsPath(meta.id))}
      />
      <PageForm onSubmit={save}>
        <FormShell sections={[{ id: "import", label: "Found on the server" }]}>
          <FormSection
            id="import"
            label="Found on the server"
            hint="Found in Claude and Codex config on the server. Already-imported entries are hidden."
            action={
              found && !loadError && found.length > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="pointer-coarse:h-11"
                  onClick={() => setSelected(selected.length === all.length ? [] : all)}
                >
                  {selected.length === all.length ? "None" : "All"}
                </Button>
              ) : undefined
            }
          >
            {found === null ? (
              <PickerSkeleton rows={4} />
            ) : loadError ? (
              <ErrorNote error={loadError} />
            ) : (
              <DataTable
                columns={columns}
                data={f.rows}
                getRowId={(item) => item.id}
                pageSize={50}
                maxHeight="32rem"
                mark={() => React.createElement(meta.icon)}
                selection={{
                  ids: selectedIds,
                  onChange: (ids) => setSelected([...ids]),
                  renderToolbar: () => null,
                }}
                filtering={found.length > 0 ? f.filtering : undefined}
                toolbar={
                  found.length > 0 ? (
                    <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {selected.length} of {found.length} selected
                    </span>
                  ) : undefined
                }
                emptyIcon={React.createElement(meta.icon)}
                emptyMessage={
                  found.length === 0
                    ? `Nothing left to import — the library already has every ${noun} found on the server.`
                    : `Nothing matches “${f.query.trim()}”.`
                }
              />
            )}
          </FormSection>
        </FormShell>
        <FormActions busy={busy} onCancel={() => void navigate(settingsPath(meta.id))} />
      </PageForm>
    </>
  )
}

/** POST when creating, PUT when editing — every library form does this. */
export async function saveLibraryEntry(
  settings: ServerSettings,
  endpoint: string,
  id: string | undefined,
  payload: unknown
) {
  await api(settings, id ? `${endpoint}/${id}` : endpoint, {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  })
}
