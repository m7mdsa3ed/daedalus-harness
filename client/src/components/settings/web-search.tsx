import * as React from "react"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import { api } from "@/lib/settings"
import { Globe, Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/notice"
import { PageForm, PageHeader, Field, FormActions, FormSection, Group, Row, StatStrip } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/** The server-global web-search backend, as the client sees it (token redacted). */
interface WebSearchServerConfig {
  configured: boolean
  searchApiBaseUrl?: string
  searchApiToken?: undefined
  searchModel?: string
  fetchModel?: string
  hasToken?: boolean
}

export function WebSearchPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("web-search")
  const [configured, setConfigured] = React.useState(false)
  const [form, setForm] = React.useState({
    searchApiBaseUrl: "",
    searchApiToken: "",
    searchModel: "",
    fetchModel: "",
  })
  const [hasToken, setHasToken] = React.useState(false)
  // The Host cell shows what is stored, not what is being typed.
  const [savedUrl, setSavedUrl] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const load = React.useCallback(async () => {
    try {
      const cfg = await api<WebSearchServerConfig>(settings, "/api/config/web-search")
      setConfigured(cfg.configured)
      setHasToken(Boolean(cfg.hasToken))
      setSavedUrl(cfg.searchApiBaseUrl ?? "")
      setForm({
        searchApiBaseUrl: cfg.searchApiBaseUrl ?? "",
        searchApiToken: "",
        searchModel: cfg.searchModel ?? "",
        fetchModel: cfg.fetchModel ?? "",
      })
    } catch (err) {
      reportError(err, "Couldn't load the web-search config")
    }
  }, [settings])

  React.useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaveError(null)
    try {
      const saved = await api<WebSearchServerConfig>(settings, "/api/config/web-search", {
        method: "PUT",
        body: JSON.stringify({
          searchApiBaseUrl: form.searchApiBaseUrl,
          searchApiToken: form.searchApiToken,
          searchModel: form.searchModel,
          fetchModel: form.fetchModel,
        }),
      })
      setConfigured(true)
      setHasToken(Boolean(saved.hasToken))
      setSavedUrl(form.searchApiBaseUrl)
      setForm((f) => ({ ...f, searchApiToken: "" }))
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the web-search config"))
    } finally {
      setBusy(false)
    }
  }

  const host = savedUrl.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")

  return (
    <>
      <PageHeader meta={meta} />
      {!configured && (
        <Notice tone="info" className="mb-8">
          No web-search backend configured yet — fill this in to give profiles a default to inherit.
        </Notice>
      )}
      <StatStrip
        stats={[
          { label: "Backend", value: configured ? "Configured" : "Not configured", tone: configured ? "ok" : "warn" },
          { label: "Host", value: host || "—" },
          { label: "Token", value: hasToken ? "Stored" : "Not set", tone: hasToken ? "ok" : "warn" },
        ]}
      />
      <Group label="What it serves" hint="One backend answers both tools.">
        <Row icon={Search} title="web_search" subtitle={<span className="font-mono">/v1/search</span>}>
          <span className="max-w-32 truncate font-mono text-sm text-muted-foreground">{form.searchModel || "—"}</span>
        </Row>
        <Row icon={Globe} title="web_fetch" subtitle={<span className="font-mono">/v1/web/fetch</span>}>
          <span className="max-w-32 truncate font-mono text-sm text-muted-foreground">{form.fetchModel || "—"}</span>
        </Row>
      </Group>
      <p className="mt-3 px-1 text-sm text-pretty text-muted-foreground">
        The token only ever leaves the server process at spawn — it is never shown back to clients and never stored
        in the database. Each profile can override these values in Settings › Profiles.
      </p>
      <PageForm onSubmit={save} className="mt-8 min-w-0 space-y-0 [&>footer]:mt-8">
        <FormSection label="Connection" hint="Where the backend lives and how the harness signs in to it.">
          <div className="grid gap-4 @panel-sm:grid-cols-2">
            <Field label="Search API base URL" hint="e.g. http://localhost:20128">
              <Input
                value={form.searchApiBaseUrl}
                onChange={(e) => set({ searchApiBaseUrl: e.target.value })}
                placeholder="http://localhost:20128"
                aria-label="Search API base URL"
                className="h-11 font-mono text-sm @panel-sm:h-9"
                required
              />
            </Field>
            <Field label="Search API token" hint={hasToken ? "Stored — leave empty to keep it." : "Never sent back to clients."}>
              <Input
                type="password"
                aria-label="Search API token"
                autoComplete="new-password"
                value={form.searchApiToken}
                onChange={(e) => set({ searchApiToken: e.target.value })}
                className="h-11 @panel-sm:h-9"
              />
            </Field>
          </div>
        </FormSection>
        <FormSection label="Models" hint="What the backend serves for each tool.">
          <div className="grid gap-4 @panel-sm:grid-cols-2">
            <Field label="Search model" hint="Answers web_search, served at /v1/search.">
              <Input aria-label="Search model" value={form.searchModel} onChange={(e) => set({ searchModel: e.target.value })} placeholder="search-combo" className="h-11 font-mono text-sm @panel-sm:h-9" required />
            </Field>
            <Field label="Fetch model" hint="Answers web_fetch, served at /v1/web/fetch.">
              <Input aria-label="Fetch model" value={form.fetchModel} onChange={(e) => set({ fetchModel: e.target.value })} placeholder="fetch-combo" className="h-11 font-mono text-sm @panel-sm:h-9" required />
            </Field>
          </div>
        </FormSection>
        <FormActions busy={busy} onCancel={() => void load()} error={saveError} />
      </PageForm>
    </>
  )
}
