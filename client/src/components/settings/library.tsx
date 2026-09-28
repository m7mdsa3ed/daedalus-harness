/* ── Library sections ──
   The generic list+import scaffolding both library pages (MCP servers, skills)
   share. Not a route of its own. */
import * as React from "react"
import { Download, Pencil, Plus, Trash2 } from "lucide-react"
import { useNavigate } from "react-router"
import { ErrorNote } from "@/components/error-note"
import { captureError, reportError, reportPromise, type InlineError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { PickerSkeleton } from "@/components/ui/skeletons"
import { useConfirm } from "@/components/confirm-dialog"
import { api, type ImportCandidates, type ServerSettings } from "@/lib/settings"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { PageForm, FormPageHeader, PageHeader, EmptyCard, Picker } from "./primitives"
import { SettingsList } from "./list"
import { type SectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/** List + create/edit dialog for a library registry. Both registries share it. */
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
  editable = () => true,
  importable = true,
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
  /** Per-row controls before Edit / Delete — the MCP page's Connect and its
      status pill, which are about a row rather than about the library. */
  rowExtra?: (item: T) => React.ReactNode
  /** This row's own mark, where the rows of a library are not all the same
      kind of thing — MCP servers can carry registry logos or transport marks.
      Defaults to the section's icon. */
  rowIcon?: (item: T) => React.ReactNode
  /** The detail line, drawn. `subtitle` stays the *string* — it is what search
      matches on, and a node cannot be searched — so a page that wants badges
      and prose supplies both: the words to match, and the shape to draw.
      Defaults to `subtitle` in monospace, which is right when the detail is a
      command or a URL and wrong when it is a sentence. */
  rowDetail?: (item: T) => React.ReactNode
  /** Whether a row gets an Edit button. Every row can still be deleted. */
  editable?: (item: T) => boolean
  /** Whether there is anything to import from. False for a library the agents'
      own configs know nothing about (personas), where the button would open a
      scan that can only ever come back empty. */
  importable?: boolean
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

  const newButton = (
    <Button onClick={() => void navigate(settingsFormPath(meta.id))}>
      <Plus className="size-4" /> New {noun}
    </Button>
  )
  const actions = (
    <div className="flex flex-wrap justify-end gap-2">
      {extraActions}
      {importable && (
        <Button variant="outline" onClick={() => void navigate(settingsFormPath(meta.id, "import"))}>
          <Download className="size-4" /> Import
        </Button>
      )}
      {newButton}
    </div>
  )

  return (
    <>
      <PageHeader meta={meta} action={actions} />
      {/* One list shape for all five library pages (`settings/list.tsx`). The
          `rowExtra` a page passes — MCP's Connect button and its status pill —
          is a *column*, not something crowded in beside Edit and Delete: it is
          a fact about the row, and a fact belongs under a heading. */}
      <SettingsList
        rows={items}
        rowId={(item) => item.id}
        search={
          items.length > 8
            ? {
                placeholder: `Search ${noun}s…`,
                matches: (item, needle) =>
                  `${item.name} ${subtitle(item)}`.toLowerCase().includes(needle),
              }
            : undefined
        }
        columns={[
          {
            id: "name",
            header: noun,
            cell: (item) => {
              const mark = rowIcon?.(item) ?? <meta.icon className="size-4 shrink-0 text-muted-foreground" />
              return (
                <div className="flex min-w-0 items-center gap-2.5">
                  {mark}
                  <span className="truncate font-medium">{item.name}</span>
                </div>
              )
            },
          },
          {
            id: "detail",
            header: "Detail",
            cell: (item) =>
              rowDetail?.(item) ?? (
                <span className="font-mono text-xs break-all text-muted-foreground">
                  {subtitle(item)}
                </span>
              ),
            secondary: true,
          },
          ...(rowExtra
            ? [
                {
                  id: "status",
                  header: "Status",
                  align: "end" as const,
                  cell: (item: T) => (
                    <div className="flex items-center justify-end gap-1.5">{rowExtra(item)}</div>
                  ),
                },
              ]
            : []),
        ]}
        actions={[
          {
            id: "edit",
            label: "Edit",
            icon: <Pencil />,
            hidden: (item) => !editable(item),
            onClick: (item) => void navigate(settingsFormPath(meta.id, item.id)),
          },
          {
            id: "delete",
            label: "Delete",
            icon: <Trash2 />,
            tone: "danger",
            onClick: (item) => void remove(item),
          },
        ]}
        renderCard={(item) => {
          const mark = rowIcon?.(item) ?? <meta.icon className="size-4 shrink-0 text-muted-foreground" />
          return (
            <>
              <div className="flex min-w-0 items-center gap-2.5">
                {mark}
                <span className="truncate text-sm font-medium">{item.name}</span>
              </div>
              <div className="mt-1 text-[11px] break-all text-muted-foreground">
                {rowDetail?.(item) ?? <span className="font-mono">{subtitle(item)}</span>}
              </div>
              {rowExtra && <div className="mt-2 flex flex-wrap gap-1.5">{rowExtra(item)}</div>}
            </>
          )
        }}
        empty={
          <EmptyCard
            icon={meta.icon}
            text={
              importable
                ? `No ${noun}s yet — add one, or import from the agents' own configs.`
                : `No ${noun}s yet.`
            }
            action={actions}
          />
        }
      />
    </>
  )
}

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
  const [found, setFound] = React.useState<({ id: string; name: string; source: string } & Record<string, unknown>)[] | null>(
    null
  )
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

  return (
    <>
      <FormPageHeader
        title={`Import ${noun}s`}
        description="Choose definitions already configured for agents on this server. Existing library entries are hidden."
        onBack={() => void navigate(settingsPath(meta.id))}
      />
      <PageForm onSubmit={save}>
      {found === null ? (
        <div className="py-2">
          <PickerSkeleton rows={4} />
        </div>
      ) : loadError ? (
        <ErrorNote error={loadError} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 text-xs text-pretty text-muted-foreground">
              Found in Claude and Codex config on the server. Already-imported entries are hidden.
            </p>
            {found.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected(selected.length === all.length ? [] : all)}
              >
                {selected.length === all.length ? "None" : "All"}
              </Button>
            )}
          </div>
          <Picker
            items={found}
            selected={selected}
            onToggle={setSelected}
            subtitle={(item) => (
              <>
                <span className="font-sans text-muted-foreground/70">{item.source}</span>
                <br />
                {(item.url as string) ?? (item.path as string) ?? (item.command as string) ?? (item.description as string) ?? ""}
              </>
            )}
            empty={`Nothing left to import — the library already has every ${noun} found on the server.`}
          />
        </>
      )}
      <footer className="flex flex-col-reverse gap-2 border-t pt-4 @panel-sm:flex-row @panel-sm:justify-end">
        <Button type="button" variant="outline" onClick={() => void navigate(settingsPath(meta.id))}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || selected.length === 0}>
          {busy ? "Importing…" : selected.length ? `Import ${selected.length}` : "Import"}
        </Button>
      </footer>
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
