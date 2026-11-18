import * as React from "react"

import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments"
import { useComposerPrefs } from "@/lib/composer-prefs"
import { qualityBits } from "@/lib/screen-record-options"
import { toast } from "@/lib/toast"

const supported =
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  typeof MediaRecorder !== "undefined"

// Stop a little short of the cap so the last chunk still fits.
const BYTE_BUDGET = MAX_ATTACHMENT_BYTES - 256 * 1024

/** Screen recording into a `.webm` File. When it stops — by the key, by the
    browser's own "Stop sharing", or at the attachment cap — the file is held as
    `review` for the reader to watch, and only `accept` hands it to `onFile`;
    `discard` drops it. Nothing reaches the attachments unseen. Quality, frame
    rate and audio are the composer prefs, read when a recording starts. */
export function useScreenRecord(onFile: (file: File) => void) {
  const prefs = useComposerPrefs()
  const prefsRef = React.useRef(prefs)
  prefsRef.current = prefs
  const [recording, setRecording] = React.useState(false)
  const [review, setReview] = React.useState<File | null>(null)
  /* What the live row draws while recording: when it began, and how much of
     the attachment budget it has used. */
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  const [bytes, setBytes] = React.useState(0)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const onFileRef = React.useRef(onFile)
  onFileRef.current = onFile

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
  }, [])

  const start = React.useCallback(async () => {
    if (!supported || recorderRef.current) return
    const { screenQuality, screenFps, screenAudio } = prefsRef.current
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: screenFps }, audio: screenAudio })
    } catch {
      return // the reader cancelled the picker
    }
    const recorder = new MediaRecorder(stream, { videoBitsPerSecond: qualityBits(screenQuality) })
    const chunks: Blob[] = []
    let bytes = 0
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      chunks.push(event.data)
      bytes += event.data.size
      setBytes(bytes)
      if (bytes >= BYTE_BUDGET && recorder.state === "recording") {
        toast.info("Screen recording stopped at the attachment size limit")
        recorder.stop()
      }
    }
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop()
      recorderRef.current = null
      setRecording(false)
      setStartedAt(null)
      const type = recorder.mimeType.split(";")[0] || "video/webm"
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
      if (chunks.length === 0) return
      setReview(new File(chunks, `screen-recording-${stamp}.webm`, { type }))
    }
    // The browser's own "Stop sharing" ends the track, not the recorder.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop()
    })
    recorder.start(1000)
    recorderRef.current = recorder
    setBytes(0)
    setStartedAt(Date.now())
    setRecording(true)
  }, [])

  const accept = React.useCallback(() => {
    if (review) onFileRef.current(review)
    setReview(null)
  }, [review])
  const discard = React.useCallback(() => setReview(null), [])
  // An edited take replaces the one under review; it is still unattached.
  const replace = React.useCallback((file: File) => setReview(file), [])

  React.useEffect(() => stop, [stop])

  return { supported, recording, startedAt, bytes, budget: BYTE_BUDGET, review, start, stop, accept, discard, replace }
}
