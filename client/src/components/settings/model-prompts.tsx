import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { type ModelPrompt, type ServerSettings } from "@/lib/settings"
import { useInvalidateCatalog, useModelPrompts } from "@/lib/queries/catalog"
import { FormPageHeader, PageForm, Field, FormActions } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibrarySection, saveLibraryEntry } from "./library"
import { useAsyncAction } from "@/hooks/use-async-action"
import { settingsPath } from "@/lib/router"

/**
 * Model prompts: instruction text assigned to a model by id or glob pattern.
 *
 * The library list, with one thing missing on purpose — there is no Import.
 * No agent ships a model prompt in its own config: this is the harness's
 * concept, delivered to the runtime through `{modelPromptsFile}`. The built-in
 * family calibrations in the runtime are the auto-detect half; these rows are
 * the assignment half — "this text, for that model" — and win over the
 * built-ins whenever one matches.
 */
export function ModelPromptsPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("model-prompts")
  const prompts = useModelPrompts()
  const invalidate = useInvalidateCatalog()
  return (
    <LibrarySection
      meta={meta}
      items={prompts}
      endpoint="/api/model-prompts"
      noun="model prompt"
      importable={false}
      subtitle={(p) =>
        p.enabled
          ? `${p.match} · ${p.prompt.split("\n")[0]}`
          : `${p.match} · disabled`
      }
      settings={settings}
      refresh={() => invalidate("model-prompts")}
    />
  )
}

export function ModelPromptFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const prompts = useModelPrompts()
  const invalidate = useInvalidateCatalog()
  const prompt = entryId === "new" ? null : prompts.find((item) => item.id === entryId)
  if (entryId !== "new" && !prompt) return <Navigate to={settingsPath("model-prompts")} replace />
  return (
    <ModelPromptForm
      prompt={prompt ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await invalidate("model-prompts")
        void navigate(settingsPath("model-prompts"))
      }}
    />
  )
}

function ModelPromptForm({
  prompt,
  settings,
  onDone,
}: {
  prompt: ModelPrompt | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: prompt?.name ?? "",
    match: prompt?.match ?? "",
    prompt: prompt?.prompt ?? "",
    enabled: prompt?.enabled ?? true,
    sortOrder: String(prompt?.sortOrder ?? 0),
  }))
  const { busy, error: saveError, run } = useAsyncAction()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    void run("Couldn't save the model prompt", async () => {
      await saveLibraryEntry(settings, "/api/model-prompts", prompt?.id, {
        name: form.name,
        match: form.match,
        prompt: form.prompt,
        enabled: form.enabled,
        sortOrder: Number(form.sortOrder) || 0,
      })
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={prompt ? `Edit ${prompt.name}` : "New model prompt"}
        description="Instruction text assigned to a model by id or pattern. A row whose match is a glob wins over the runtime's built-in family calibrations. The file is re-read every turn, so a live model change swaps the guidance with no respawn."
        onBack={() => onDone(false)}
      />
      <PageForm
        onSubmit={save}
        aiBuilder={{
          title: "model prompt",
          value: form,
          onApply: (value) => setForm((current) => ({ ...current, ...value })),
          schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Human-readable name for these model-specific instructions.", examples: ["Qwen concise"] },
              match: { type: "string", description: "Case-insensitive glob or exact model id that selects this prompt.", examples: ["qwen*", "gpt-4.1"] },
              prompt: { type: "string", description: "Short tuning instructions appended to the runtime prompt; do not replace base instructions.", examples: ["Prefer concise answers. State assumptions and verify behavior with tests when appropriate."] },
              enabled: { type: "boolean", description: "Whether the rule is active.", examples: [true] },
              sortOrder: { type: "string", description: "Numeric ordering value; ties break by name.", examples: ["0"] },
            },
            required: ["name", "match", "prompt", "enabled", "sortOrder"],
            additionalProperties: false,
          },
        }}
      >
        <Field label="Name" hint="What this prompt is called in the list.">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Qwen strict"
            required
          />
        </Field>
        <Field
          label="Match"
          hint="A glob over the model id. No wildcards = exact id match. Use * for a family — e.g. qwen*, gemini-2.5*, deepseek*. Case-insensitive."
        >
          <Input
            value={form.match}
            onChange={(e) => set({ match: e.target.value })}
            placeholder="qwen*"
            className="font-mono text-xs"
            required
          />
        </Field>
        <Field
          label="Instructions"
          hint="Appended as a layer of the agent's system prompt, ahead of the project files. Keep it short — a few bullets about how to drive this engine. Avoid contradicting the base prompt; these lines tune it, not replace it."
        >
          <Textarea
            value={form.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={8}
            className="font-mono text-xs"
            required
          />
        </Field>
        <Field
          label="Enabled"
          hint="Off keeps the row managed but stops it matching. The runtime's built-in family calibration stands in."
        >
          {/* `id`/`htmlFor` rather than a wrapping <label>: Base UI's Checkbox
              renders a button, which a wrapping label does not toggle. */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="model-prompt-enabled"
              checked={form.enabled}
              onCheckedChange={(enabled) => set({ enabled })}
            />
            <Label htmlFor="model-prompt-enabled" className="text-sm font-normal">
              Enabled
            </Label>
          </div>
        </Field>
        <Field label="Order" hint="Where it sits in the list. Ties break by name.">
          <Input
            type="number"
            step={10}
            value={form.sortOrder}
            onChange={(e) => set({ sortOrder: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>
        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
