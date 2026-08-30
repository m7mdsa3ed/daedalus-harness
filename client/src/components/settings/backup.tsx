import * as React from "react"
import { toast } from "sonner"
import { AlertTriangle, Download, FileJson, Upload } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { reportError } from "@/lib/errors"
import { ApiError, api, type ServerSettings } from "@/lib/settings"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/* ── Backup ──
   Export everything the server stores as one JSON file, and restore one.
   The server owns both halves (server/src/backup.ts): this page only chooses
   what to leave out of an export (secrets, transcripts), reads the counts out
   of a chosen file so the person can see what they are about to import, and
   picks merge vs replace. After an import the app reloads — every list it
   holds (profiles, projects, threads) may have changed underneath it, and a
   hard reload is the one path that is known to pick all of it up. */

/** The bundle's table names, in the order the page lists them. Counts only —
    the rest of the document is the server's business. */
const TABLES = [
  ["agents", "Agents"],
  ["profiles", "Profiles"],
  ["mcpServers", "MCP servers"],
  ["skills", "Skills"],
  ["commands", "Commands"],
  ["projects", "Projects"],
  ["knowledge", "Knowledge entries"],
  ["previews", "Saved previews"],
  ["sessions", "Threads"],
  ["events", "Transcript events"],
  ["queue", "Queued prompts"],
  ["scheduled", "Scheduled prompts"],
  ["tasks", "Tasks"],
  ["webSearchUsage", "Web-search usage rows"],
  ["pushTokens", "Push tokens"],
] as const

type TableKey = (typeof TABLES)[number][0]

interface BundlePeek {
  format: string
  version: number
  exportedAt?: number
  redacted?: { secrets?: boolean; journals?: boolean }
  counts: Record<TableKey, number>
  hasWebSearch: boolean
}

type ImportSummary = Record<TableKey, number> & { orphaned: number; missingSecrets: boolean }

/** What the file says about itself, without trusting it for anything else. */
function peek(text: string): BundlePeek {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (raw.format !== "daedalus-backup") throw new Error("This is not a Daedalus backup file.")
  const counts = {} as Record<TableKey, number>
  for (const [key] of TABLES) counts[key] = Array.isArray(raw[key]) ? (raw[key] as unknown[]).length : 0
  const config = raw.config as { webSearch?: unknown } | undefined
  return {
    format: raw.format,
    version: Number(raw.version),
    exportedAt: typeof raw.exportedAt === "number" ? raw.exportedAt : undefined,
    redacted: raw.redacted as BundlePeek["redacted"],
    counts,
    hasWebSearch: Boolean(config?.webSearch),
  }
}

/** Fetch the bundle with the bearer token and hand it to the browser as a
    download. `api()` parses JSON; this wants the bytes and the filename the
    server chose, so it goes to fetch directly. */
async function downloadBackup(settings: ServerSettings, opts: { secrets: boolean; journals: boolean }) {
  const url = new URL("/api/backup", settings.url)
  // The server defaults secrets to OFF now; carrying them needs the explicit
  // opt-in. Sent both ways so the intent is never left to a default.
  url.searchParams.set("secrets", opts.secrets ? "1" : "0")
  if (!opts.journals) url.searchParams.set("journals", "0")
  const res = await fetch(url, { headers: { authorization: `Bearer ${settings.token}` } })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let serverMessage = text.trim() || undefined
    try {
      const body = JSON.parse(text) as { error?: unknown }
      if (typeof body.error === "string") serverMessage = body.error
    } catch {
      /* not JSON */
    }
    throw new ApiError({ status: res.status, path: "/api/backup", serverMessage })
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "daedalus-backup.json"
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
  return { name, bytes: blob.size }
}

const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

export function BackupPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("backup")
  return (
    <>
      <PageHeader meta={meta} />
      <ExportGroup settings={settings} />
      <ImportGroup settings={settings} />
    </>
  )
}

function ExportGroup({ settings }: { settings: ServerSettings }) {
  const [secrets, setSecrets] = React.useState(true)
  const [journals, setJournals] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  const run = async () => {
    setBusy(true)
    try {
      const { name, bytes } = await downloadBackup(settings, { secrets, journals })
      toast("Backup exported", { description: `${name} · ${formatBytes(bytes)}` })
    } catch (err) {
      reportError(err, "Couldn't export the backup")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group label="Export">
      <Row
        title="Include credentials"
        subtitle="Profile API keys, MCP header and env values, and the web-search token. Leave this on for a backup you mean to restore from; turn it off for a file you mean to share."
      >
        <Switch checked={secrets} onCheckedChange={setSecrets} aria-label="Include credentials" />
      </Row>
      <Row
        title="Include thread transcripts"
        subtitle="The journaled event log of every thread — the bulk of the file. Without it, threads still come back and revive through the agent's own store, but can't be read until they do."
      >
        <Switch checked={journals} onCheckedChange={setJournals} aria-label="Include thread transcripts" />
      </Row>
      <Row
        icon={Download}
        title="Download backup"
        subtitle="One JSON file with everything on this server: agents, profiles, projects, the library, knowledge, threads, schedules, tasks and the web-search backend. Not included: the server's own token, host and port."
      >
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? <Spinner /> : <Download className="size-4" />}
          Export
        </Button>
      </Row>
    </Group>
  )
}

function ImportGroup({ settings }: { settings: ServerSettings }) {
  const confirm = useConfirm()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [file, setFile] = React.useState<{ name: string; size: number; text: string; peek: BundlePeek } | null>(null)
  const [mode, setMode] = React.useState<"merge" | "replace">("merge")
  const [busy, setBusy] = React.useState(false)

  const pick = async (picked: File | undefined) => {
    if (!picked) return
    try {
      const text = await picked.text()
      setFile({ name: picked.name, size: picked.size, text, peek: peek(text) })
    } catch (err) {
      setFile(null)
      reportError(err, "Couldn't read that file")
    }
  }

  const run = async () => {
    if (!file) return
    const ok = await confirm({
      title: mode === "replace" ? "Replace everything on this server?" : "Merge this backup in?",
      description:
        mode === "replace"
          ? "Every profile, project, thread, library entry, knowledge entry, schedule and task on this server is deleted first and the backup put in its place. Running agents are stopped. This cannot be undone."
          : "Rows in the backup overwrite rows with the same id; everything else on the server is kept. Threads named in the backup are stopped and reloaded.",
      confirmLabel: mode === "replace" ? "Replace" : "Merge",
      destructive: mode === "replace",
    })
    if (!ok) return
    setBusy(true)
    try {
      const summary = await api<ImportSummary>(settings, `/api/backup/import?mode=${mode}`, {
        method: "POST",
        body: file.text,
      })
      const total = TABLES.reduce((n, [key]) => n + (summary[key] ?? 0), 0)
      const notes = [
        summary.orphaned ? `${summary.orphaned} row(s) skipped — their project or thread exists nowhere` : null,
        summary.missingSecrets ? "the backup carried no credentials and this server had none to keep" : null,
      ].filter(Boolean)
      toast("Backup imported — reloading", {
        description: `${total} rows${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
      })
      // Everything the app holds may have changed; reboot it against the new state.
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      reportError(err, "Couldn't import the backup")
      setBusy(false)
    }
  }

  return (
    <Group label="Import">
      <Row
        icon={FileJson}
        title={file ? file.name : "Choose a backup file"}
        subtitle={
          file
            ? `${formatBytes(file.size)}${file.peek.exportedAt ? ` · exported ${new Date(file.peek.exportedAt).toLocaleString()}` : ""}`
            : "A JSON file exported from this page, on this server or another."
        }
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0])
            e.target.value = ""
          }}
        />
        <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
          <Upload className="size-4" />
          {file ? "Choose another" : "Choose file"}
        </Button>
      </Row>
      {file && (
        <>
          <div className="px-4 py-3">
            <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Contents</div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              {TABLES.map(([key, label]) => (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="truncate text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{file.peek.counts[key]}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-2">
                <dt className="truncate text-muted-foreground">Web-search backend</dt>
                <dd>{file.peek.hasWebSearch ? "yes" : "no"}</dd>
              </div>
            </dl>
            {(file.peek.redacted?.secrets || file.peek.redacted?.journals) && (
              <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span>
                  This backup was exported
                  {file.peek.redacted?.secrets ? " without credentials" : ""}
                  {file.peek.redacted?.secrets && file.peek.redacted?.journals ? " and" : ""}
                  {file.peek.redacted?.journals ? " without thread transcripts" : ""}.
                  {file.peek.redacted?.secrets
                    ? " Credentials this server already holds for the same profiles and servers are kept."
                    : ""}
                </span>
              </p>
            )}
          </div>
          <div className="px-4 py-3">
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as "merge" | "replace")} className="gap-3">
              <label className="flex cursor-pointer items-start gap-3">
                <RadioGroupItem value="merge" id="backup-merge" className="mt-0.5" />
                <span>
                  <Label htmlFor="backup-merge" className="cursor-pointer">
                    Merge
                  </Label>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Rows in the backup overwrite rows with the same id. Everything else on this server is kept.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3">
                <RadioGroupItem value="replace" id="backup-replace" className="mt-0.5" />
                <span>
                  <Label htmlFor="backup-replace" className="cursor-pointer">
                    Replace
                  </Label>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Delete everything on this server first, then restore the backup. Running agents are stopped.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>
          <Row
            title={mode === "replace" ? "Replace this server's data" : "Merge into this server"}
            subtitle="The app reloads when the import finishes."
          >
            <Button variant={mode === "replace" ? "destructive" : "default"} onClick={() => void run()} disabled={busy}>
              {busy ? <Spinner /> : <Upload className="size-4" />}
              Import
            </Button>
          </Row>
        </>
      )}
    </Group>
  )
}
