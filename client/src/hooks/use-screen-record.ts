import * as React from "react"

import { MAX_ATTACHMENT_BYTES } from "@/lib/attachments"
import { toast } from "@/lib/toast"

const supported =
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  typeof MediaRecorder !== "undefined"

/* Low enough that a couple of minutes fit under the attachment cap; a screen
   of text stays legible at this rate. */
const VIDEO_BITS = 600_000
// Stop a little short of the cap so the last chunk still fits.
const BYTE_BUDGET = MAX_ATTACHMENT_BYTES - 256 * 1024

/** Screen recording into a `.webm` File, handed to `onFile` when it stops —
    by the key, by the browser's own "Stop sharing", or at the attachment cap. */
export function useScreenRecord(onFile: (file: File) => void) {
  const [recording, setRecording] = React.useState(false)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const onFileRef = React.useRef(onFile)
  onFileRef.current = onFile

  const stop = React.useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== "inactive") recorder.stop()
  }, [])

  const start = React.useCallback(async () => {
    if (!supported || recorderRef.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true })
    } catch {
      return // the reader cancelled the picker
    }
    const recorder = new MediaRecorder(stream, { videoBitsPerSecond: VIDEO_BITS })
    const chunks: Blob[] = []
    let bytes = 0
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      chunks.push(event.data)
      bytes += event.data.size
      if (bytes >= BYTE_BUDGET && recorder.state === "recording") {
        toast.info("Screen recording stopped at the attachment size limit")
        recorder.stop()
      }
    }
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop()
      recorderRef.current = null
      setRecording(false)
      const type = recorder.mimeType.split(";")[0] || "video/webm"
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")
      onFileRef.current(new File(chunks, `screen-recording-${stamp}.webm`, { type }))
    }
    // The browser's own "Stop sharing" ends the track, not the recorder.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop()
    })
    recorder.start(1000)
    recorderRef.current = recorder
    setRecording(true)
  }, [])

  React.useEffect(() => stop, [stop])

  return { supported, recording, start, stop }
}
