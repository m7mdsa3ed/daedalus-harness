import * as React from "react"
import { reportError } from "@/lib/errors"
import { api } from "@/lib/settings"
import { Input } from "@/components/ui/input"
import { PageForm, PageHeader, Group, Field, FormActions } from "./primitives"
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
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const load = React.useCallback(async () => {
    try {
      const cfg = await api<WebSearchServerConfig>(settings, "/api/config/web-search")
      setConfigured(cfg.configured)
      setHasToken(Boolean(cfg.hasToken))
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
      setForm((f) => ({ ...f, searchApiToken: "" }))
    } catch (err) {
      reportError(err, "Couldn't save the web-search config")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader meta={meta} />
      {!configured && (
        <p className="mb-2 px-1 text-xs text-pretty text-muted-foreground">
          No web-search backend configured yet — fill this in to give profiles a default to inherit.
        </p>
      )}
      <PageForm onSubmit={save}>
        <Group label="Default backend">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Search API base URL" hint="e.g. http://localhost:20128">
            <Input
              value={form.searchApiBaseUrl}
              onChange={(e) => set({ searchApiBaseUrl: e.target.value })}
              placeholder="http://localhost:20128"
              className="font-mono text-xs"
              required
            />
            </Field>
            <Field label="Search API token" hint={hasToken ? "Stored — leave empty to keep it." : "Never sent back to clients."}>
              <Input type="password" value={form.searchApiToken} onChange={(e) => set({ searchApiToken: e.target.value })} />
            </Field>
            <Field label="Search model" hint="Model the backend serves for /v1/search.">
              <Input value={form.searchModel} onChange={(e) => set({ searchModel: e.target.value })} placeholder="search-combo" className="font-mono text-xs" required />
            </Field>
            <Field label="Fetch model" hint="Model the backend serves for /v1/web/fetch.">
              <Input value={form.fetchModel} onChange={(e) => set({ fetchModel: e.target.value })} placeholder="fetch-combo" className="font-mono text-xs" required />
            </Field>
          </div>
        </Group>
        <FormActions busy={busy} onCancel={() => void load()} />
      </PageForm>
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        The token only ever leaves the server process at spawn — it is never shown back to clients and never stored in
        the database. Each profile can override these values in Settings › Profiles.
      </p>
    </>
  )
}
