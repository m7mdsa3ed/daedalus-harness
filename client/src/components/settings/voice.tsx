import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { captureError, type InlineError } from "@/lib/errors"
import {
  useDeleteVoiceProvider,
  useSaveVoiceProvider,
  useVoiceProviders,
  type VoiceProvider,
  type VoiceProviderId,
} from "@/lib/queries"
import { useMcpServers } from "@/lib/queries/catalog"
import { AudioLines, Radio, Settings2, Trash2 } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { cn } from "@/lib/utils"
import { Notice } from "@/components/notice"
import { PageHeader, FormPageHeader, FormActions, PageForm, Field, Group, Row, StatStrip, StatusBadge } from "./primitives"
import { SettingsList, type ListAction, type ListColumn } from "./list"
import { sectionMeta } from "./sections"
import { settingsFormPath, settingsPath } from "@/lib/router"

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

const labelOf = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id

/* One control, both ways in: the dropdown lists what is known and filters as
   you type, and the field itself stays editable, so a name that matches nothing
   is simply the value (the group picker's bargain, in profile-models.tsx). */
function SuggestInput({
  value,
  onChange,
  options,
  placeholder,
  required,
  ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: Suggestion[]
  placeholder?: string
  required?: boolean
  ariaLabel?: string
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
      <ComboboxInput placeholder={placeholder} aria-label={ariaLabel} className="w-full font-mono text-sm" required={required} />
      <ComboboxContent>
        <ComboboxList>
          {options.map(([v, note]) => (
            <ComboboxItem key={v} value={v}>
              <span className="font-mono text-sm">{v}</span>
              <span className="ms-auto ps-3 text-xs text-muted-foreground">{note}</span>
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
  mcpServerIds: string[]
  instructions: string
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
  const ids = [...(rows ?? []).map((r) => r.provider as string), ...(value && !rows?.some((r) => r.provider === value) ? [value] : [])]
  return (
    <Field label="Voice backend" hint={hint ?? "Which realtime model a voice call on these threads uses."}>
      <Select value={value || "default"} onValueChange={(v) => onChange(!v || v === "default" ? "" : v)}>
        <SelectTrigger className="w-full @panel-sm:w-56">
          <SelectValue>{value ? labelOf(value) : "Default"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default</SelectItem>
          {ids.map((id) => (
            <SelectItem key={id} value={id}>
              {labelOf(id)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/* A backend as the Backends table draws it: the preset beside the stored row
   (absent until a key is saved). */
interface BackendRow {
  preset: (typeof PROVIDERS)[number]
  row: VoiceProvider | undefined
}

const MARKS = { openai: AudioLines, google: Radio } as const

export function VoicePage() {
  const meta = sectionMeta("voice")
  const navigate = useNavigate()
  const { data: rows, error: loadError, isLoading } = useVoiceProviders()
  const remove = useDeleteVoiceProvider()
  const [removeError, setRemoveError] = React.useState<InlineError | null>(null)

  const removeBackend = React.useCallback(
    (p: (typeof PROVIDERS)[number]) =>
      remove.mutate(p.id, { onError: (err) => setRemoveError(captureError(err, `Couldn't remove ${p.label}`)) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remove.mutate]
  )

  /* The editor is a page of its own (`:entryId`, `VoiceFormPage`). */
  const configure = React.useCallback(
    (id: VoiceProviderId) => void navigate(settingsFormPath("voice", id)),
    [navigate]
  )

  const backends = React.useMemo<BackendRow[]>(
    () => PROVIDERS.map((preset) => ({ preset, row: rows?.find((r) => r.provider === preset.id) })),
    [rows]
  )

  const columns = React.useMemo<ListColumn<BackendRow>[]>(
    () => [
      {
        id: "name",
        title: true,
        header: "Backend",
        cell: ({ preset }) => <span className="font-medium">{preset.label}</span>,
      },
      {
        id: "model",
        header: "Model",
        secondary: true,
        cell: ({ preset, row }) => (
          <span className="block max-w-56 truncate font-mono text-sm text-muted-foreground">{row?.model ?? preset.model}</span>
        ),
      },
      {
        id: "voice",
        header: "Voice",
        secondary: true,
        cell: ({ preset, row }) => (
          <span className="block max-w-32 truncate font-mono text-sm text-muted-foreground">{row?.voice || preset.voice}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        align: "end",
        cell: ({ row }) => (
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            <StatusBadge tone={row?.hasKey ? "ok" : "warn"}>{row?.hasKey ? "Key stored" : "No key"}</StatusBadge>
            {row?.isDefault && <StatusBadge tone="info">Default</StatusBadge>}
          </span>
        ),
      },
    ],
    []
  )

  const actions = React.useMemo<ListAction<BackendRow>[]>(
    () => [
      { id: "configure", label: "Configure", icon: <Settings2 />, onClick: ({ preset }) => configure(preset.id), position: "left" },
      {
        id: "remove",
        label: "Remove",
        icon: <Trash2 />,
        tone: "danger",
        hidden: ({ row }) => !row,
        disabled: () => remove.isPending,
        onClick: ({ preset }) => removeBackend(preset),
      },
    ],
    [configure, removeBackend, remove.isPending]
  )

  const defaultLabel = rows?.find((r) => r.isDefault)
  const configured = rows?.filter((r) => r.hasKey).length ?? 0

  return (
    <div>
      <PageHeader meta={meta} />
      {loadError && <ErrorNote error={captureError(loadError, "Couldn't load the voice backends")} />}
      {!isLoading && rows?.length === 0 && (
        <Notice tone="neutral" className="mb-8">
          No voice backend yet — add a key for either provider to turn on voice mode in the composer.
        </Notice>
      )}
      {rows && (
        <StatStrip
          stats={[
            { label: "Voice mode uses", value: defaultLabel ? labelOf(defaultLabel.provider) : "None chosen" },
            { label: "Backends with a key", value: `${configured} of ${PROVIDERS.length}` },
          ]}
        />
      )}
      <ErrorNote error={removeError} />
      {(rows || isLoading) && (
        <div className="mb-8">
          <SettingsList
            columns={columns}
            rows={backends}
            loading={isLoading}
            rowId={({ preset }) => preset.id}
            actions={actions}
            mark={({ preset }) => {
              const Mark = MARKS[preset.id]
              return <Mark className="size-4 text-muted-foreground" />
            }}
            onRowClick={({ preset }) => configure(preset.id)}
            emptyIcon={AudioLines}
            emptyText="No voice backends."
            search={{ placeholder: "Search backends…", matches: ({ preset, row }, n) => `${preset.label} ${row?.model ?? preset.model} ${row?.voice || preset.voice}`.toLowerCase().includes(n) }}
            fields={[{ id: "status", label: "Status", of: ({ row }) => (row?.hasKey ? "Key stored" : "No key") }]}
          />
        </div>
      )}
      <Group label="How it works">
        <Row
          title="Keys stay on the server"
          subtitle="A voice call is given a short-lived token minted from the key, not the key itself."
        />
        <Row
          title="Instructions and tools bound in"
          subtitle="The token carries the thread's instructions and tools with it."
        />
        <Row
          title="Billed per token"
          subtitle="Realtime audio is billed by the provider per token, on what the model hears and says. The agent's own work is billed by its profile, not here."
        />
      </Group>
    </div>
  )
}

/* One backend's key, model, voice, MCP servers and instructions, as a page of
   its own (`/settings/voice/:entryId`) — the same shape a project's or an MCP
   server's form has. Saving writes this backend only and goes back. */
export function VoiceFormPage() {
  const { entryId } = useParams()
  const p = PROVIDERS.find((x) => x.id === entryId)
  const { data: rows, isLoading } = useVoiceProviders()
  if (!p) return <Navigate to={settingsPath("voice")} replace />
  if (isLoading || !rows) return null
  return <VoiceForm preset={p} row={rows.find((r) => r.provider === p.id)} />
}

function VoiceForm({ preset: p, row }: { preset: (typeof PROVIDERS)[number]; row: VoiceProvider | undefined }) {
  const navigate = useNavigate()
  const mcpServers = useMcpServers()
  const save = useSaveVoiceProvider()
  const [saveError, setSaveError] = React.useState<InlineError | null>(null)
  const [draft, setDraft] = React.useState<Draft>(() => ({
    apiKey: "",
    model: row?.model ?? p.model,
    voice: row?.voice ?? p.voice,
    isDefault: row?.isDefault ?? false,
    mcpServerIds: row?.mcpServerIds ?? [],
    instructions: row?.instructions ?? "",
  }))
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const toggleMcp = (id: string) =>
    set({
      mcpServerIds: draft.mcpServerIds.includes(id)
        ? draft.mcpServerIds.filter((x) => x !== id)
        : [...draft.mcpServerIds, id],
    })
  const back = () => void navigate(settingsPath("voice"))
  const control = "w-60 max-w-full @panel-sm:w-72"

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaveError(null)
    try {
      await save.mutateAsync({ provider: p.id, ...draft })
      back()
    } catch (err) {
      setSaveError(captureError(err, "Couldn't save the voice settings"))
    }
  }

  return (
    <>
      <FormPageHeader title={p.label} description="Key, model and voice for this backend." onBack={back} />
      <PageForm onSubmit={submit}>
        <Group>
          <Row
            title="Use for voice mode"
            subtitle={row ? "The backend the composer's voice button connects to." : "Save a key first."}
          >
            {draft.isDefault && <StatusBadge tone="info">Default</StatusBadge>}
            <Switch
              checked={draft.isDefault}
              disabled={!row && !draft.apiKey}
              onCheckedChange={(on) => set({ isDefault: on })}
              aria-label={`Use ${p.label} for voice mode`}
            />
          </Row>
          <Row title="API key" subtitle={row?.hasKey ? "Stored — leave empty to keep it." : p.keyHint}>
            <Input
              type="password"
              autoComplete="off"
              aria-label={`${p.label} API key`}
              className={cn(control, "h-11 @panel-sm:h-9")}
              value={draft.apiKey}
              required={!row?.hasKey}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
          </Row>
          <Row title="Model" subtitle="Pick one or type any realtime model the provider serves.">
            <div className={control}>
              <SuggestInput
                value={draft.model}
                onChange={(model) => set({ model })}
                options={p.models}
                placeholder={p.model}
                ariaLabel={`${p.label} model`}
                required
              />
            </div>
          </Row>
          <Row title="Voice" subtitle="Search the voices or type a name. Empty uses the provider's default.">
            <div className={control}>
              <SuggestInput
                value={draft.voice}
                onChange={(voice) => set({ voice })}
                options={p.voices}
                placeholder={p.voice}
                ariaLabel={`${p.label} voice`}
              />
            </div>
          </Row>

          {/* These are this voice backend's own MCPs, separate from any
              thread's links. Picked here, bound into the voice token. */}
          <Row title="MCP servers" subtitle="External services this voice call may use directly — web search, knowledge base, a database, a browser.">
            <div className="space-y-1">
              {mcpServers.map((s) => {
                const active = draft.mcpServerIds.includes(s.id)
                return (
                  <Label
                    key={s.id}
                    className="w-full rounded-md px-2 py-1.5 font-normal hover:bg-muted has-disabled:opacity-50"
                  >
                    <Checkbox
                      checked={active}
                      onCheckedChange={() => toggleMcp(s.id)}
                      disabled={save.isPending}
                      aria-label={`Use ${s.name} for ${p.label} voice mode`}
                    />
                    <span className="font-mono">{s.name}</span>
                    {s.type === "builtin" && s.builtin === "web-search" && (
                      <span className="ms-auto text-xs text-muted-foreground">web search + fetch</span>
                    )}
                    {s.type === "builtin" && s.builtin === "knowledge" && (
                      <span className="ms-auto text-xs text-muted-foreground">knowledge base</span>
                    )}
                  </Label>
                )
              })}
              {mcpServers.length === 0 && (
                <p className="text-sm text-muted-foreground">No MCP servers in the library yet — add one in Settings › MCP.</p>
              )}
            </div>
          </Row>

          <Row title="Instructions" subtitle="Custom voice-mode prompt. Empty uses the built-in voice instructions.">
            <Textarea
              value={draft.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              className={cn(control, "h-24 @panel-sm:h-20")}
              aria-label={`${p.label} voice instructions`}
            />
          </Row>
        </Group>
        <FormActions busy={save.isPending} onCancel={back} error={saveError} />
      </PageForm>
    </>
  )
}
