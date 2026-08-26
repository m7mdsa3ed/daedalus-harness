/* ── Library sections ──
   The generic list+import scaffolding both library pages (MCP servers, skills)
   share. Not a route of its own. */
import * as React from "react"
import { Download, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { PickerSkeleton } from "@/components/ui/skeletons"
import { useConfirm } from "@/components/confirm-dialog"
import { api, type ImportCandidates, type ServerSettings } from "@/lib/settings"
import { PageHeader, Group, Row, EmptyCard, Picker } from "./primitives"
import { type SectionMeta } from "./sections"

/** List + create/edit dialog for a library registry. Both registries share it. */
export function LibrarySection<T extends { id: string; name: string }>({
  meta,
  items,
  endpoint,
  importKind,
  noun,
  subtitle,
  settings,
  refresh,
  renderForm,
}: {
  meta: SectionMeta
  items: T[]
  endpoint: string
  /** Which side of GET /api/import this section imports from. */
  importKind: "mcpServers" | "skills" | "commands"
  noun: string
  subtitle: (item: T) => string
  settings: ServerSettings
  refresh: () => Promise<void>
  renderForm: (item: T | null, onDone: (saved: boolean) => void) => React.ReactNode
}) {
  const confirm = useConfirm()
  const [editing, setEditing] = React.useState<T | "new" | null>(null)
  const [importing, setImporting] = React.useState(false)

  const remove = async (item: T) => {
    if (!(await confirm({ title: `Delete "${item.name}"?`, destructive: true, confirmLabel: "Delete" }))) return
    try {
      await api(settings, `${endpoint}/${item.id}`, { method: "DELETE" })
      await refresh()
    } catch (err) {
      reportError(err, `Couldn't delete the ${noun}`)
    }
  }

  const newButton = (
    <Button size="lg" onClick={() => setEditing("new")}>
      <Plus className="size-4" /> New {noun}
    </Button>
  )
  const actions = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="lg" variant="outline" onClick={() => setImporting(true)}>
        <Download className="size-4" /> Import
      </Button>
      {newButton}
    </div>
  )

  return (
    <>
      <PageHeader meta={meta} action={actions} />
      {items.length === 0 ? (
        <EmptyCard icon={meta.icon} text={`No ${noun}s yet — add one, or import from the agents' own configs.`} action={actions} />
      ) : (
        <Group>
          {items.map((item) => (
            <Row key={item.id} icon={meta.icon} title={item.name} subtitle={<span className="font-mono">{subtitle(item)}</span>}>
              <Button variant="ghost" size="icon-lg" title="Edit" onClick={() => setEditing(item)}>
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon-lg" title="Delete" onClick={() => remove(item)}>
                <Trash2 />
              </Button>
            </Row>
          ))}
        </Group>
      )}
      <ResponsiveDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <ResponsiveDialogContent>
          {editing !== null &&
            renderForm(editing === "new" ? null : editing, async (saved) => {
              if (saved) await refresh()
              setEditing(null)
            })}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
      <ResponsiveDialog open={importing} onOpenChange={setImporting}>
        <ResponsiveDialogContent className="sm:max-w-xl">
          {importing && (
            <ImportDialog
              kind={importKind}
              endpoint={endpoint}
              noun={noun}
              settings={settings}
              onDone={async (imported) => {
                if (imported) await refresh()
                setImporting(false)
              }}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}

/**
 * Pick from what the agents on the server already have configured
 * (~/.claude.json, ~/.codex/config.toml, skill directories) and copy the
 * selection into the library. Entries already in the library are filtered out
 * server-side.
 */
function ImportDialog({
  kind,
  endpoint,
  noun,
  settings,
  onDone,
}: {
  kind: "mcpServers" | "skills" | "commands"
  endpoint: string
  noun: string
  settings: ServerSettings
  onDone: (imported: boolean) => void
}) {
  const [found, setFound] = React.useState<({ id: string; name: string; source: string } & Record<string, unknown>)[] | null>(
    null
  )
  const [selected, setSelected] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    api<ImportCandidates>(settings, "/api/import")
      .then((r) => setFound(r[kind].map((item, i) => ({ ...item, id: String(i) }))))
      .catch((err) => {
        reportError(err, "Couldn't load what there is to import")
        setFound([])
      })
  }, [settings, kind])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      for (const id of selected) {
        const item = found?.find((f) => f.id === id)
        if (!item) continue
        const { id: _id, source: _source, ...payload } = item
        await api(settings, endpoint, { method: "POST", body: JSON.stringify(payload) })
      }
      toast.success(`Imported ${selected.length} ${noun}${selected.length === 1 ? "" : "s"}`)
      onDone(true)
    } catch (err) {
      reportError(err, `Couldn't import the ${noun}s`)
      setBusy(false)
    }
  }

  const all = found?.map((f) => f.id) ?? []

  return (
    <form onSubmit={save} className="space-y-4">
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Import {noun}s</ResponsiveDialogTitle>
      </ResponsiveDialogHeader>
      {found === null ? (
        <div className="py-2">
          <PickerSkeleton rows={4} />
        </div>
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
      <div className="sticky bottom-0 -mx-1 mt-2 flex justify-end gap-2 bg-gradient-to-t from-popover via-popover to-transparent px-1 pt-3 pb-1">
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || selected.length === 0}>
          {busy ? "Importing…" : selected.length ? `Import ${selected.length}` : "Import"}
        </Button>
      </div>
    </form>
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
