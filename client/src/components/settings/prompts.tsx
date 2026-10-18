import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { type SavedPrompt, type ServerSettings } from "@/lib/settings"
import { useInvalidateCatalog, usePrompts } from "@/lib/queries/catalog"
import { FormPageHeader, PageForm, Field, FormActions, FormSection, FormShell, StatusBadge } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"
import { LibrarySection, saveLibraryEntry } from "./library"
import { useAsyncAction } from "@/hooks/use-async-action"
import { settingsPath } from "@/lib/router"

/**
 * Saved prompts: reusable text, mentioned as `@handle` in the composer. The
 * server expands the handle at send time. No Import: no agent has one to give.
 */
export function PromptsPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("prompts")
  const prompts = usePrompts()
  const invalidate = useInvalidateCatalog()
  return (
    <LibrarySection
      meta={meta}
      items={prompts}
      endpoint="/api/prompts"
      noun="saved prompt"
      importable={false}
      subtitle={(p) => [p.title, p.description || p.prompt.split("\n")[0]].filter(Boolean).join(" - ")}
      rowHandle={(p) => `@${p.name}`}
      rowBadges={(p) => (
        <>
          {p.title && (
            <Badge variant="outline" className="max-w-full">
              <span className="truncate">{p.title}</span>
            </Badge>
          )}
          {p.seededVersion > 0 && <StatusBadge tone="neutral" dot={false}>built-in</StatusBadge>}
        </>
      )}
      rowDetail={(p) => p.description || p.prompt}
      settings={settings}
      refresh={() => invalidate("prompts")}
    />
  )
}

export function PromptFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const { settings } = useSettingsPage()
  const prompts = usePrompts()
  const invalidate = useInvalidateCatalog()
  const prompt = entryId === "new" ? null : prompts.find((item) => item.id === entryId)
  if (entryId !== "new" && !prompt) return <Navigate to={settingsPath("prompts")} replace />
  return (
    <PromptForm
      prompt={prompt ?? null}
      settings={settings}
      onDone={async (saved) => {
        if (saved) await invalidate("prompts")
        void navigate(settingsPath("prompts"))
      }}
    />
  )
}

const HANDLE = /^[a-z0-9][a-z0-9_-]*$/

function PromptForm({
  prompt,
  settings,
  onDone,
}: {
  prompt: SavedPrompt | null
  settings: ServerSettings
  onDone: (saved: boolean) => void
}) {
  const [form, setForm] = React.useState(() => ({
    name: prompt?.name ?? "",
    title: prompt?.title ?? "",
    description: prompt?.description ?? "",
    prompt: prompt?.prompt ?? "",
  }))
  const { busy, error: saveError, run } = useAsyncAction()
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }))
  const valid = HANDLE.test(form.name)

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) return
    void run("Couldn't save the saved prompt", async () => {
      await saveLibraryEntry(settings, "/api/prompts", prompt?.id, { ...form, sortOrder: prompt?.sortOrder ?? 0 })
      onDone(true)
    })
  }

  return (
    <>
      <FormPageHeader
        title={prompt ? `Edit @${prompt.name}` : "New saved prompt"}
        description="Reusable text. Type @handle in the composer and the server replaces it with this prompt when the message is sent."
        onBack={() => onDone(false)}
      />
      <PageForm
        onSubmit={save}
        aiBuilder={{
          title: "saved prompt",
          value: form,
          onApply: (value) => setForm((current) => ({ ...current, ...value })),
          schema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Lowercase handle used as @name in the composer.", pattern: "^[a-z0-9][a-z0-9_-]*$", examples: ["quick-fix"] },
              title: { type: "string", description: "Optional PascalCase display name.", examples: ["QuickFix"] },
              description: { type: "string", description: "Optional short summary shown in the @ autocomplete list." },
              prompt: { type: "string", description: "Reusable instructions expanded by the server when the handle is sent.", examples: ["Make the smallest correct change. Preserve existing patterns and add tests for changed behavior."] },
            },
            required: ["name", "prompt"],
            additionalProperties: false,
          },
        }}
      >
        <FormShell
          sections={[
            { id: "identity", label: "Identity" },
            { id: "prompt", label: "Prompt" },
          ]}
        >
          <FormSection id="identity" label="Identity">
            <div className="grid gap-4 @panel-sm:grid-cols-2">
              <Field
                label="Handle"
                hint={
                  form.name && !valid
                    ? "Lowercase letters, digits, - and _ only, starting with a letter or digit."
                    : `Mentioned as @${form.name || "handle"}.`
                }
              >
                <Input
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="quick-fix"
                  className="font-mono text-xs"
                  required
                />
              </Field>
              <Field label="Title" hint="Display name, PascalCase. Optional.">
                <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="QuickFix" />
              </Field>
            </div>
            <Field label="Description" hint="One line, shown in the @ list. Optional.">
              <Input
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="The smallest correct change. No refactors."
              />
            </Field>
          </FormSection>
          <FormSection id="prompt" label="Prompt">
            <Field label="Prompt" hint="The text that replaces the handle.">
              <Textarea
                value={form.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                rows={12}
                className="font-mono text-xs"
                required
              />
            </Field>
          </FormSection>
        </FormShell>
        <FormActions busy={busy} onCancel={() => onDone(false)} error={saveError} />
      </PageForm>
    </>
  )
}
