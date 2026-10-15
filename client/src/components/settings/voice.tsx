import * as React from "react"
import { captureError, type InlineError } from "@/lib/errors"
import {
  useDeleteVoiceProvider,
  useSaveVoiceProvider,
  useVoiceProviders,
  type VoiceProviderId,
} from "@/lib/queries"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ErrorNote } from "@/components/error-note"
import { PageForm, PageHeader, Group, Field, FormActions, Row } from "./primitives"
import { sectionMeta } from "./sections"

/* What each provider is called here and what its fields start as. The model
   and voice are suggestions, never a closed list: both providers rename them
   every few months, so a field offers what is known (searchable, with a short
   note on each) and still takes anything typed — the list going stale costs a
   missing suggestion, never a voice you cannot use. */
type Suggestion = [value: string, note: string]

const OPENAI_VOICES: Suggestion[] = [
  ["marin", "Clear, professional"],
  ["cedar", "Natural, conversational"],
  ["alloy", "Neutral, balanced"],
  ["ash", "Clear"],
  ["ballad", "Warm, expressive"],
  ["coral", "Friendly"],
  ["echo", "Warm, engaging"],
  ["sage", "Calm"],
  ["shimmer", "Bright, energetic"],
  ["verse", "Versatile"],
]

const GEMINI_VOICES: Suggestion[] = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"],
  ["Fenrir", "Excitable"], ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"],
  ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
]

const PROVIDERS: {
  id: VoiceProviderId
  label: string
  model: string
  voice: string
  keyHint: string
  models: Suggestion[]
  voices: Suggestion[]
}[] = [
  {
    id: "openai",
    label: "OpenAI Realtime",
    model: "gpt-realtime",
    voice: "alloy",
    keyHint: "An OpenAI API key (sk-…).",
    models: [
      ["gpt-realtime", "Current realtime model"],
      ["gpt-realtime-mini", "Cheaper, faster"],
      ["gpt-4o-realtime-preview", "Earlier preview"],
    ],
    voices: OPENAI_VOICES,
  },
  {
    id: "google",
    label: "Gemini Live",
    model: "gemini-3.1-flash-live-preview",
    voice: "Kore",
    keyHint: "A Gemini API key from Google AI Studio.",
    models: [
      ["gemini-3.1-flash-live-preview", "Live, preview"],
      ["gemini-2.5-flash-native-audio-preview-09-2025", "Native audio, preview"],
      ["gemini-live-2.5-flash-preview", "Live 2.5 preview"],
    ],
    voices: GEMINI_VOICES,
  },
]

/* One control, both ways in: the dropdown lists what is known and filters as
   you type, and the field itself stays editable, so a name that matches nothing
   is simply the value (the group picker's bargain, in profile-models.tsx). */
function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  required,
}: {
  value: string
  onChange: (value: string) => void
  options: Suggestion[]
  placeholder?: string
  required?: boolean
}) {
  return (
    <Combobox
      items={options.map(([v]) => v)}
      value={value || null}
      inputValue={value}
      onInputValueChange={(next) => onChange(typeof next === "string" ? next : "")}
      onValueChange={(next: string | null) => {
        if (next !== null) onChange(next)
      }}
    >
      <ComboboxInput placeholder={placeholder} className="w-full font-mono text-xs" required={required} />
      <ComboboxContent>
        <ComboboxList>
          {options.map(([v, note]) => (
            <ComboboxItem key={v} value={v}>
              <span className="font-mono text-xs">{v}</span>
              <span className="ms-auto ps-3 text-[11px] text-muted-foreground">{note}</span>
            </ComboboxItem>
          ))}
        </ComboboxList>
        <ComboboxEmpty>No match — what you typed is used as it is.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

interface Draft {
  apiKey: string
  model: string
  voice: string
  isDefault: boolean
}

/* The per-scope pick on a project's and a profile's pages. "Default" is "no
   say": the next scope out, then Settings › Voice's default, decides. Only
   configured backends are offered; a stored one this install lacks still
   reads as itself rather than as a blank. */
export function VoiceBackendField({
  value,
  onChange,
  hint,
}: {
  value: string | null | undefined
  onChange: (provider: string) => void
  hint?: string
}) {
  const { data: rows } = useVoiceProviders()
  const label = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id
  const ids = [...(rows ?? []).map((r) => r.provider as string), ...(value && !rows?.some((r) => r.provider === value) ? [value] : [])]
  return (
    <Field label="Voice backend" hint={hint ?? "Which realtime model a voice call on these threads uses."}>
      <Select value={value || "default"} onValueChange={(v) => onChange(!v || v === "default" ? "" : v)}>
        <SelectTrigger className="h-9 w-full @panel-sm:w-56">
          <SelectValue>{value ? label(value) : "Default"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default</SelectItem>
          {ids.map((id) => (
            <SelectItem key={id} value={id}>
              {label(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function VoicePage() {
  const meta = sectionMeta("voice")
  const { data: rows, error: loadError, isLoading } = useVoiceProviders()
  const save = useSaveVoiceProvider()
  const remove = useDeleteVoiceProvider()
  const [drafts, setDrafts] = React.useState<Record<VoiceProviderId, Draft> | null>(null)
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)

  /* The form is the rows as they were read; re-read after a save so a key that
     became "stored" says so and the default moves where the server put it. */
  const reset = React.useCallback(() => {
    if (!rows) return
    const of = (id: VoiceProviderId): Draft => {
      const row = rows.find((r) => r.provider === id)
      const preset = PROVIDERS.find((p) => p.id === id)!
      return { apiKey: "", model: row?.model ?? preset.model, voice: row?.voice ?? preset.voice, isDefault: row?.isDefault ?? false }
    }
    setDrafts({ openai: of("openai"), google: of("google") })
  }, [rows])
  React.useEffect(reset, [reset])

  const set = (id: VoiceProviderId, patch: Partial<Draft>) =>
    setDrafts((d) => {
      if (!d) return d
      const next = { ...d, [id]: { ...d[id], ...patch } }
      /* One default: turning one on turns the other off, as the server will. */
      if (patch.isDefault) for (const other of PROVIDERS) if (other.id !== id) next[other.id] = { ...next[other.id], isDefault: false }
      return next
    })

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!drafts) return
    setSaveError(null)
    try {
      /* A provider is saved when it already has a key or one was typed; the
         other is left alone rather than refused for a key nobody gave it. */
      for (const p of PROVIDERS) {
        const draft = drafts[p.id]
        const stored = rows?.some((r) => r.provider === p.id && r.hasKey)
        if (!stored && !draft.apiKey.trim()) continue
        await save.mutateAsync({ provider: p.id, ...draft })
      }
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the voice settings"))
    }
  }

  return (
    <>
      <PageHeader meta={meta} />
      {loadError && <ErrorNote error={captureError(loadError, "Couldn't load the voice backends")} />}
      {!isLoading && rows?.length === 0 && (
        <p className="mb-2 px-1 text-xs text-pretty text-muted-foreground">
          No voice backend yet — add a key for either provider to turn on voice mode in the composer.
        </p>
      )}
      {drafts && (
        <PageForm onSubmit={submit}>
          {PROVIDERS.map((p) => {
            const row = rows?.find((r) => r.provider === p.id)
            const draft = drafts[p.id]
            return (
              <Group key={p.id} label={p.label}>
                <Row
                  title="Use for voice mode"
                  subtitle={row ? "The backend the composer's voice button connects to." : "Save a key first."}
                >
                  <Switch
                    checked={draft.isDefault}
                    disabled={!row && !draft.apiKey}
                    onCheckedChange={(on) => set(p.id, { isDefault: on })}
                    aria-label={`Use ${p.label} for voice mode`}
                  />
                </Row>
                <div className="grid gap-4 py-4 @panel-sm:grid-cols-2">
                  <Field label="API key" hint={row?.hasKey ? "Stored — leave empty to keep it." : p.keyHint}>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={draft.apiKey}
                      onChange={(e) => set(p.id, { apiKey: e.target.value })}
                    />
                  </Field>
                  <Field label="Model" hint="Pick one or type any realtime model the provider serves.">
                    <SuggestInput
                      value={draft.model}
                      onChange={(model) => set(p.id, { model })}
                      options={p.models}
                      placeholder={p.model}
                      required
                    />
                  </Field>
                  <Field label="Voice" hint="Search the voices or type a name. Empty uses the provider's default.">
                    <SuggestInput
                      value={draft.voice}
                      onChange={(voice) => set(p.id, { voice })}
                      options={p.voices}
                      placeholder={p.voice}
                    />
                  </Field>
                </div>
                {row && (
                  <Row title="Remove this backend" subtitle="Deletes the stored key.">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate(p.id, {
                          onError: (err) => setSaveError(captureError(err, `Couldn't remove ${p.label}`)),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </Row>
                )}
              </Group>
            )
          })}
          <FormActions busy={save.isPending} onCancel={reset} error={saveError} />
        </PageForm>
      )}
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        Keys stay on the server. A voice call is given a short-lived token minted from the key, with its instructions
        and tools bound in. Realtime audio is billed per token by the provider; the mic pauses while the agent works,
        so its silence is not streamed.
      </p>
    </>
  )
}
