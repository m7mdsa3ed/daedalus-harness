import * as React from "react"
import { Download, FileJson, Upload } from "lucide-react"
import { useConfirm } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { captureError, reportPromise, type InlineError } from "@/lib/errors"
import { ApiError, api, type ServerSettings } from "@/lib/settings"
import { FormActions, Group, PageForm, PageHeader, Row, Section, Segmented, StatusBadge, TabBar } from "./primitives"
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
  ["personas", "Personas"],
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

type Side = "export" | "import"

const SIDES = [
  { id: "export", label: "Export", icon: Download },
  { id: "import", label: "Import", icon: Upload },
]

/* Export | Import is the page's view switch, so it is the kit's TabBar: one
   panel at a time on every width. Both stay mounted, the other hidden by CSS,
   so a half-made choice (a picked file, a toggle) survives a flip. The
   destructive choice (Replace) is a Notice where the mode is picked, so the
   warning is exactly where the click is. */
export function BackupPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("backup")
  const [side, setSide] = React.useState<Side>("export")
  return (
    <>
      <PageHeader meta={meta} />
      <TabBar items={SIDES} value={side} onChange={(id) => setSide(id as Side)} label="Backup" />
      <div hidden={side !== "export"}>
        <ExportPanel settings={settings} />
      </div>
      <div hidden={side !== "import"}>
        <ImportPanel settings={settings} />
      </div>
    </>
  )
}

/** One checklist line: included or not, said by a StatusBadge. */
function Check({ on, label, value, off = "Not included" }: { on: boolean; label: string; value?: React.ReactNode; off?: string }) {
  return (
    <Row title={label}>
      {value !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{value}</span>}
      <StatusBadge tone={on ? "ok" : "neutral"}>{on ? "Included" : off}</StatusBadge>
    </Row>
  )
}

function ExportPanel({ settings }: { settings: ServerSettings }) {
  const [secrets, setSecrets] = React.useState(true)
  const [journals, setJournals] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  /* An export is the server serialising every table it has, so it is the
     archetypal case for the promise toast: the spinner in the button says the
     click landed, and this says what is happening to someone who has already
     looked away from it. */
  const run = () => {
    setBusy(true)
    // The rejection is already on screen (and marked reported) — swallowing it
    // here is what keeps the global net from saying the same thing twice.
    void reportPromise(downloadBackup(settings, { secrets, journals }), {
      loading: "Exporting the backup…",
      success: ({ name, bytes }) => ({
        title: "Backup exported",
        description: `${name} · ${formatBytes(bytes)}`,
      }),
      context: "Couldn't export the backup",
    })
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <PageForm
      onSubmit={(e) => {
        e.preventDefault()
        run()
      }}
    >
      <Group
        label="Export"
        hint="One JSON file with everything on this server. Not included: the server's own token, host and port."
      >
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
      </Group>
      <Group label="In the file">
        {TABLES.map(([key, label]) => (
          <Check key={key} on={key !== "events" || journals} label={label} />
        ))}
        <Check on label="Web-search backend" />
        <Check on={secrets} label="Credentials" />
      </Group>
      <FormActions
        busy={busy}
        submitLabel="Export"
        leading={<span className="text-sm text-muted-foreground">Downloads to this device.</span>}
      />
    </PageForm>
  )
}

function ImportPanel({ settings }: { settings: ServerSettings }) {
  const confirm = useConfirm()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [file, setFile] = React.useState<{ name: string; size: number; text: string; peek: BundlePeek } | null>(null)
  const [mode, setMode] = React.useState<"merge" | "replace">("merge")
  const [busy, setBusy] = React.useState(false)
  /* An unreadable or unparseable file leaves the row saying "Choose a backup
     file" — exactly what it said before the pick. The reason has to be next to
     the button, not in a corner. */
  const [pickError, setPickError] = React.useState<InlineError | null>(null)

  const pick = async (picked: File | undefined) => {
    if (!picked) return
    setPickError(null)
    try {
      const text = await picked.text()
      setFile({ name: picked.name, size: picked.size, text, peek: peek(text) })
    } catch (err) {
      setFile(null)
      setPickError(captureError(err, "Couldn't read that file"))
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
    /* The one toast covers the whole import — an import stops threads, rewrites
       tables and reloads the manager, so "working" is a state worth naming, and
       the reload at the end means a second toast would only flash. */
    void reportPromise(
      api<ImportSummary>(settings, `/api/backup/import?mode=${mode}`, {
        method: "POST",
        body: file.text,
      }),
      {
        loading: mode === "replace" ? "Replacing this server's data…" : "Merging the backup in…",
        success: (summary) => {
          const total = TABLES.reduce((n, [key]) => n + (summary[key] ?? 0), 0)
          const notes = [
            summary.orphaned ? `${summary.orphaned} row(s) skipped — their project or thread exists nowhere` : null,
            summary.missingSecrets ? "the backup carried no credentials and this server had none to keep" : null,
          ].filter(Boolean)
          // Everything the app holds may have changed; reboot it against the new state.
          setTimeout(() => window.location.reload(), 1200)
          return {
            title: "Backup imported — reloading",
            description: `${total} rows${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
          }
        },
        context: "Couldn't import the backup",
      }
    ).catch(() => setBusy(false))
  }

  const replace = mode === "replace"
  const redacted = file?.peek.redacted
  return (
    <PageForm
      onSubmit={(e) => {
        e.preventDefault()
        void run()
      }}
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
      <Group label="Import" hint="Restore from a JSON file exported from this page, on this server or another.">
        <Row
          icon={FileJson}
          title={file ? file.name : "Choose a backup file"}
          subtitle={
            file
              ? `${formatBytes(file.size)}${file.peek.exportedAt ? ` · exported ${new Date(file.peek.exportedAt).toLocaleString()}` : ""}`
              : "Nothing is read until you pick a file; you confirm before anything changes."
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <Upload data-icon="inline-start" />
            {file ? "Choose another" : "Choose file"}
          </Button>
        </Row>
      </Group>
      {pickError && (
        <Section>
          <ErrorNote error={pickError} />
        </Section>
      )}
      {file ? (
        <>
          <Group label="In this file">
            {TABLES.map(([key, label]) => (
              <Check key={key} on={file.peek.counts[key] > 0} off="None" label={label} value={file.peek.counts[key]} />
            ))}
            <Check on={file.peek.hasWebSearch} off="None" label="Web-search backend" value={file.peek.hasWebSearch ? "yes" : "no"} />
          </Group>
          {(redacted?.secrets || redacted?.journals) && (
            <Section>
              <Notice tone="warn">
                This backup was exported
                {redacted.secrets ? " without credentials" : ""}
                {redacted.secrets && redacted.journals ? " and" : ""}
                {redacted.journals ? " without thread transcripts" : ""}.
                {redacted.secrets
                  ? " Credentials this server already holds for the same profiles and servers are kept."
                  : ""}
              </Notice>
            </Section>
          )}
          <Section label="How it comes in" hint={replace
            ? "Delete everything on this server first, then restore the backup. Running agents are stopped."
            : "Rows in the backup overwrite rows with the same id. Everything else on this server is kept."}>
            <Segmented
              label="Import mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: "merge", label: "Merge" },
                { value: "replace", label: "Replace" },
              ]}
            />
          </Section>
          {replace && (
            <Section>
              <Notice tone="error">Deletes this server's data first, and stops running agents. This cannot be undone.</Notice>
            </Section>
          )}
          <FormActions
            busy={busy}
            submitLabel={replace ? "Replace and import" : "Merge and import"}
            leading={<span className="text-sm text-muted-foreground">The app reloads when the import finishes.</span>}
          />
        </>
      ) : null}
    </PageForm>
  )
}
