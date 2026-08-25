import * as React from "react"

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

const SpeechRecognitionCtor: (new () => SpeechRecognitionLike) | undefined =
  (globalThis as never as Record<string, new () => SpeechRecognitionLike>).SpeechRecognition ??
  (globalThis as never as Record<string, new () => SpeechRecognitionLike>).webkitSpeechRecognition

/** Native browser dictation. `supported` is false where the API is missing (e.g. Firefox). */
export function useVoice(onText: (text: string) => void) {
  const [listening, setListening] = React.useState(false)
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null)
  const onTextRef = React.useRef(onText)
  onTextRef.current = onText

  const stop = React.useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
  }, [])

  const start = React.useCallback(() => {
    if (!SpeechRecognitionCtor || recognitionRef.current) return
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = navigator.language
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) onTextRef.current(result[0].transcript)
      }
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setListening(false)
    }
    recognition.onerror = recognition.onend
    recognition.start()
    recognitionRef.current = recognition
    setListening(true)
  }, [])

  React.useEffect(() => stop, [stop])

  return { supported: SpeechRecognitionCtor !== undefined, listening, start, stop }
}
