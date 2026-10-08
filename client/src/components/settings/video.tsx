import * as React from "react"
import { api } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { useQueryClient } from "@tanstack/react-query"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { PageForm, PageHeader, Group, Field, FormActions, Row } from "./primitives"
import { sectionMeta } from "./sections"
import { captureError, type InlineError } from "@/lib/errors"
import { videoProvidersKey } from "@/lib/queries/video"

export function VideoProvidersPage() {
  const settings = useServer()
  const queryClient = useQueryClient()
  const queryKey = videoProvidersKey(settings)
  const [model, setModel] = React.useState("eleven_multilingual_v2")
  const [voice, setVoice] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [hasKey, setHasKey] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<InlineError | null>(null)

  React.useEffect(() => {
    let active = true
    void api<{ configured: { id: string; model: string; voice: string; hasKey: boolean }[] }>(settings, "/api/video/providers")
      .then(({ configured }) => {
        const row = configured.find((provider) => provider.id === "elevenlabs")
        if (active && row) {
          setModel(row.model)
          setVoice(row.voice)
          setHasKey(row.hasKey)
        }
      }, (cause) => { if (active) setError(captureError(cause, "Couldn't load speech settings")) })
    return () => { active = false }
  }, [settings])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api(settings, "/api/video/providers/elevenlabs", { method: "PUT", body: JSON.stringify({ provider: "elevenlabs", apiKey, model, voice }) })
      setApiKey("")
      setHasKey(true)
      await queryClient.invalidateQueries({ queryKey })
    } catch (cause) {
      setError(captureError(cause, "Couldn't save speech settings"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader meta={sectionMeta("video")} />
      <PageForm onSubmit={submit}>
        <Group label="ElevenLabs TTS">
          <Row title="Batch text-to-speech" subtitle={hasKey ? "Configured; leave the key blank to keep it." : "Add an API key to generate narration from a Video thread."}>
            <span className="text-xs text-muted-foreground">{hasKey ? "Ready" : "Not configured"}</span>
          </Row>
          <div className="grid gap-4 py-4 @panel-sm:grid-cols-2">
            <Field label="API key" hint="Stored only on the server.">
              <Input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={!hasKey} />
            </Field>
            <Field label="Model ID">
              <Input value={model} onChange={(event) => setModel(event.target.value)} required />
            </Field>
            <Field label="Voice ID" hint="ElevenLabs voice identifier.">
              <Input value={voice} onChange={(event) => setVoice(event.target.value)} required />
            </Field>
          </div>
        </Group>
        <FormActions busy={busy} onCancel={() => { setApiKey(""); setError(null) }} error={error} />
      </PageForm>
      <p className="px-1 text-xs text-pretty text-muted-foreground">Video renders use Remotion locally on this server; the renderer adapter is separate from the TTS provider and can be extended independently.</p>
    </>
  )
}
