import * as React from "react"
import { AudioLines, Clapperboard, Download, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ErrorNote } from "@/components/error-note"
import { captureError, type InlineError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { fetchVideo, useGenerateVideoSpeech, useQueueVideoRender, useSaveVideo, useTtsProviders, useVideo, type VideoDocument, type VideoScene } from "@/lib/queries/video"

const blankVideo = (): VideoDocument => ({ title: "Untitled video", width: 1280, height: 720, scenes: [{ id: crypto.randomUUID(), title: "Opening scene", narration: "", durationSeconds: 5, background: "#17211e" }] })

export function VideoPanel({ sessionId }: { sessionId: string }) {
  const settings = useServer()
  const video = useVideo(sessionId)
  const tts = useTtsProviders()
  const save = useSaveVideo()
  const speech = useGenerateVideoSpeech()
  const render = useQueueVideoRender()
  const [document, setDocument] = React.useState<VideoDocument | null>(null)
  const [error, setError] = React.useState<InlineError | null>(null)
  const [notice, setNotice] = React.useState("")
  const [preview, setPreview] = React.useState<{ id: string; url: string } | null>(null)
  const previewRef = React.useRef<string | null>(null)
  const hydrated = React.useRef(false)
  React.useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current) }, [])

  React.useEffect(() => {
    if (video.data && !hydrated.current) {
      setDocument(video.data.document ?? blankVideo())
      hydrated.current = true
    }
  }, [video.data])

  const patchScene = (id: string, patch: Partial<VideoScene>) => setDocument((current) => current ? ({ ...current, scenes: current.scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene) }) : current)
  const run = async (action: () => Promise<unknown>, message: string) => {
    setError(null)
    setNotice("")
    try { await action(); setNotice(message) } catch (cause) { setError(captureError(cause, "Video action failed")) }
  }
  const saveDocument = async () => {
    if (!document) return
    await run(() => save.mutateAsync({ sessionId, document }), "Saved as a new video revision.")
  }
  const createSpeech = async (scene: VideoScene) => {
    if (!scene.narration.trim()) return setError(captureError(new Error("Add narration to this scene first."), "Cannot generate speech"))
    await run(async () => {
      if (document) await save.mutateAsync({ sessionId, document })
      await speech.mutateAsync({ sessionId, sceneId: scene.id, text: scene.narration })
      const fresh = await video.refetch()
      if (fresh.data?.document) setDocument(fresh.data.document)
    }, "Narration audio generated and attached.")
  }
  const playPreview = async (id: string) => {
    await run(async () => {
      const blob = await fetchVideo(settings, sessionId, id, true)
      const url = URL.createObjectURL(blob)
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = url
      setPreview({ id, url })
    }, "Preview loaded.")
  }
  const download = async (id: string) => {
    await run(async () => {
      const blob = await fetchVideo(settings, sessionId, id)
      const url = URL.createObjectURL(blob)
      const a = window.document.createElement("a")
      a.href = url
      a.download = `video-${id}.mp4`
      a.click()
      URL.revokeObjectURL(url)
    }, "Download started.")
  }

  if (video.isLoading || !document) return <div className="p-5 text-sm text-muted-foreground">Loading video…</div>
  const ttsReady = !!tts.data?.configured.some((provider) => provider.id === "elevenlabs")
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4 @container">
      <header className="flex items-center gap-2">
        <Clapperboard className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Video · revision {video.data?.revision ?? 0}</h2>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => void saveDocument()}>Save</Button>
        <Button size="sm" disabled={render.isPending || video.data?.renders.some((job) => job.status === "queued" || job.status === "rendering")} onClick={() => void run(async () => { await save.mutateAsync({ sessionId, document }); await render.mutateAsync({ sessionId }); await video.refetch() }, "Render queued.")}>Render</Button>
      </header>
      {video.error && <ErrorNote error={captureError(video.error, "Couldn't load video data")} />}
      {error && <ErrorNote error={error} />}
      {notice && <p className="text-xs text-muted-foreground" role="status">{notice}</p>}
      {!ttsReady && <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">Configure ElevenLabs under Settings → Video &amp; speech to generate narration audio.</p>}
      <label className="grid gap-1 text-xs text-muted-foreground">Video title<Input value={document.title} onChange={(event) => setDocument({ ...document, title: event.target.value })} /></label>
      <div className="grid gap-3">
        {document.scenes.map((scene, index) => (
          <section key={scene.id} className="grid gap-3 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2"><span className="text-xs font-medium text-muted-foreground">Scene {index + 1}</span><div className="flex-1"/><Button size="icon-xs" variant="ghost" aria-label="Remove scene" disabled={document.scenes.length <= 1} onClick={() => setDocument({ ...document, scenes: document.scenes.filter((row) => row.id !== scene.id) })}><Trash2 /></Button></div>
            <Input aria-label={`Scene ${index + 1} title`} value={scene.title} placeholder="Scene title" onChange={(event) => patchScene(scene.id, { title: event.target.value })} />
            <Textarea aria-label={`Scene ${index + 1} narration`} value={scene.narration} placeholder="Narration or scene description" onChange={(event) => patchScene(scene.id, { narration: event.target.value })} />
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-xs text-muted-foreground">Duration (seconds)<Input className="w-28" type="number" min={1} max={30} value={scene.durationSeconds} onChange={(event) => patchScene(scene.id, { durationSeconds: Number(event.target.value) })} /></label>
              <label className="grid gap-1 text-xs text-muted-foreground">Background<Input className="w-32" type="color" value={scene.background} onChange={(event) => patchScene(scene.id, { background: event.target.value })} /></label>
              <Button size="sm" variant="outline" disabled={!ttsReady || speech.isPending || !scene.narration.trim()} onClick={() => void createSpeech(scene)}><AudioLines /> Generate speech</Button>
            </div>
          </section>
        ))}
      </div>
      <Button variant="outline" onClick={() => setDocument({ ...document, scenes: [...document.scenes, { id: crypto.randomUUID(), title: "New scene", narration: "", durationSeconds: 5, background: "#17211e" }] })}><Plus /> Add scene</Button>
      <section className="grid gap-2 border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Render versions</h3>
        {!video.data?.renders.length && <p className="text-xs text-muted-foreground">No renders yet.</p>}
        {video.data?.renders.map((job) => <div key={job.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-xs"><span className="min-w-0 flex-1">r{job.revision} · {job.status}{job.status === "rendering" || job.status === "queued" ? ` · ${job.progress}%` : ""}{job.error ? ` · ${job.error}` : ""}</span>{job.status === "completed" && <><Button size="xs" variant="ghost" onClick={() => void playPreview(job.id)}>{preview?.id === job.id ? "Playing" : "Preview"}</Button><Button size="icon-xs" variant="ghost" aria-label="Download video" onClick={() => void download(job.id)}><Download /></Button></>}</div>)}
        {preview && <video key={preview.id} className="mt-2 w-full rounded-lg bg-black" controls src={preview.url} />}
      </section>
    </div>
  )
}
