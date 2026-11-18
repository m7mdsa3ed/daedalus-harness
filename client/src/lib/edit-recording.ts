/* ── Editing a finished screen recording ──
   Trim and mute, in the browser, with nothing to install: the clip is played
   from `start` to `end` in a detached <video> and what it plays is recorded
   again. That makes an edit cost the length of what is kept (it runs in real
   time), and a re-encode at the reader's chosen quality, which is the price of
   needing no WASM encoder. */

export interface RecordingEdit {
  /** Seconds into the clip where the kept part begins and ends. */
  start: number
  end: number
  /** Drop the audio track. */
  mute: boolean
}

/* Not in the DOM lib: Chromium and Safari say `captureStream`, Firefox the
   prefixed one. */
type Capturable = HTMLVideoElement & {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

function captureOf(video: HTMLVideoElement): MediaStream | null {
  const element = video as Capturable
  const capture = element.captureStream ?? element.mozCaptureStream
  return capture ? capture.call(video) : null
}

/** Whether this browser can re-encode a clip at all. */
export function canEditRecording(): boolean {
  if (typeof MediaRecorder === "undefined" || typeof document === "undefined") return false
  return "captureStream" in HTMLVideoElement.prototype || "mozCaptureStream" in HTMLVideoElement.prototype
}

/** A MediaRecorder file carries no duration, so `video.duration` is Infinity
    until the browser has been made to find the end. Seeking far past it does
    that; the answer is read back and the clip rewound. NaN when it never says. */
export function settledDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration)) return Promise.resolve(video.duration)
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      video.removeEventListener("durationchange", onChange)
      const duration = video.duration
      video.currentTime = 0
      resolve(Number.isFinite(duration) ? duration : NaN)
    }
    const onChange = () => {
      if (Number.isFinite(video.duration)) finish()
    }
    const timer = window.setTimeout(finish, 3000)
    video.addEventListener("durationchange", onChange)
    video.currentTime = 1e101
  })
}

function once(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error("The recording could not be read"))
    target.addEventListener(
      type,
      () => {
        target.removeEventListener("error", onError)
        resolve()
      },
      { once: true }
    )
    target.addEventListener("error", onError, { once: true })
  })
}

/** Re-record `file` through `edit`. Rejects with an AbortError when `signal`
    fires, and with an Error when the browser cannot do it. */
export async function editRecording(
  file: File,
  edit: RecordingEdit,
  opts: { bitsPerSecond: number; signal?: AbortSignal; onProgress?: (fraction: number) => void }
): Promise<File> {
  const { signal, onProgress } = opts
  const url = URL.createObjectURL(file)
  const video = document.createElement("video")
  video.playsInline = true
  video.preload = "auto"
  video.muted = edit.mute
  video.src = url
  let audio: AudioContext | null = null
  let recorder: MediaRecorder | null = null
  let tracks: MediaStreamTrack[] = []
  try {
    await once(video, "loadedmetadata")
    await settledDuration(video)
    video.currentTime = edit.start
    await once(video, "seeked")

    const captured = captureOf(video)
    if (!captured) throw new Error("This browser can't edit recordings")
    tracks = captured.getVideoTracks()
    if (!edit.mute) {
      /* Audio goes through a graph rather than the captured stream: a muted
         element's captured audio differs between browsers, and the graph keeps
         the element off the speakers while it is being re-recorded. */
      audio = new AudioContext()
      await audio.resume()
      const sink = audio.createMediaStreamDestination()
      audio.createMediaElementSource(video).connect(sink)
      tracks = [...tracks, ...sink.stream.getAudioTracks()]
    }

    const mimeType = MediaRecorder.isTypeSupported(file.type) ? file.type : undefined
    recorder = new MediaRecorder(new MediaStream(tracks), { videoBitsPerSecond: opts.bitsPerSecond, mimeType })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const stopped = new Promise<void>((resolve) => {
      if (recorder) recorder.onstop = () => resolve()
    })
    recorder.start(1000)
    await video.play()

    await new Promise<void>((resolve, reject) => {
      const span = Math.max(0.001, edit.end - edit.start)
      const timer = window.setInterval(() => {
        if (signal?.aborted) {
          window.clearInterval(timer)
          reject(new DOMException("Editing was cancelled", "AbortError"))
          return
        }
        onProgress?.(Math.min(1, Math.max(0, (video.currentTime - edit.start) / span)))
        if (video.currentTime >= edit.end || video.ended) {
          window.clearInterval(timer)
          resolve()
        }
      }, 100)
    })

    video.pause()
    recorder.stop()
    await stopped
    if (chunks.length === 0) throw new Error("Nothing was recorded")
    const type = recorder.mimeType.split(";")[0] || "video/webm"
    return new File(chunks, file.name.replace(/(-edited)?\.webm$/, "-edited.webm"), { type })
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop()
    for (const track of tracks) track.stop()
    if (audio) void audio.close()
    video.pause()
    video.removeAttribute("src")
    video.load()
    URL.revokeObjectURL(url)
  }
}
