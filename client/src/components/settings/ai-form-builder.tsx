import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { Bot, Send, Sparkles, WandSparkles } from "lucide-react"

import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { PanelToolbar } from "@/components/workspace/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import type { ServerSettings } from "@/lib/settings"
import { useProfiles } from "@/lib/queries/catalog"
import { aiCapable, formBuilderPick } from "@/lib/ai-picks"
import { useServer } from "@/lib/server-context"
import { captureError } from "@/lib/errors"
import { cn } from "@/lib/utils"

type JsonSchema = Record<string, unknown>

function validateSchema(schema: JsonSchema, value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["The model has not supplied a form object yet."]
  const object = value as Record<string, unknown>
  const errors: string[] = []
  const properties = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, JsonSchema>
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
  for (const key of required) {
    if (!(key in object) || object[key] === "" || object[key] === null || object[key] === undefined) errors.push(`Required field: ${key}`)
  }
  for (const [key, field] of Object.entries(properties)) {
    const item = object[key]
    if (item === undefined || item === null || item === "") continue
    if (field.type === "string" && typeof item !== "string") errors.push(`${key} must be text.`)
    if (field.type === "boolean" && typeof item !== "boolean") errors.push(`${key} must be true or false.`)
    if (field.type === "number" && (typeof item !== "number" || !Number.isFinite(item))) errors.push(`${key} must be a number.`)
    if (field.type === "integer" && (typeof item !== "number" || !Number.isInteger(item))) errors.push(`${key} must be a whole number.`)
    if (Array.isArray(field.enum) && !field.enum.some((option) => Object.is(option, item))) errors.push(`${key} must be one of the allowed options.`)
    if (typeof item === "string" && typeof field.pattern === "string") {
      try {
        if (!new RegExp(field.pattern).test(item)) errors.push(`${key} does not match its required format.`)
      } catch {
        errors.push(`${key} has an invalid schema pattern.`)
      }
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(object)) if (!(key in properties)) errors.push(`Unexpected field: ${key}`)
  }
  return errors
}

type FormBuilderProps = {
  title: string
  schema: JsonSchema
  value: Record<string, unknown>
  onApply: (value: Record<string, unknown>) => void
}

/** A schema is a form's AI contract: include field descriptions, examples, enums and required keys. */
export function AiFormBuilder({ title, schema, value, onApply }: FormBuilderProps) {
  const [open, setOpen] = React.useState(false)
  const profiles = useProfiles()
  const currentProfileId = formBuilderPick.useProfileId()
  formBuilderPick.useModelId()
  const profile = aiCapable(profiles).find((item) => item.id === currentProfileId) ?? aiCapable(profiles)[0] ?? null
  const model = formBuilderPick.resolveModelId(profile)
  const server = useServer()

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => setOpen(true)} disabled={!profile}>
        <WandSparkles data-icon="inline-start" /> Fill with AI
      </Button>
      <BuilderDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        schema={schema}
        value={value}
        profileId={profile?.id ?? ""}
        model={model}
        server={server}
        onApply={(next) => {
          onApply(next)
          setOpen(false)
        }}
      />
    </>
  )
}

function BuilderDialog({
  open,
  onOpenChange,
  title,
  schema,
  value,
  profileId,
  model,
  server,
  onApply,
}: FormBuilderProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileId: string
  model: string
  server: ServerSettings
}) {
  const [input, setInput] = React.useState("")
  const [preview, setPreview] = React.useState<Record<string, unknown>>(value)
  const authHeader = React.useMemo(() => ({ authorization: `Bearer ${server.token}` }), [server.token])
  const transport = React.useMemo(
    () => new DefaultChatTransport({
      api: new URL("/api/form-builder", server.url).toString(),
      headers: authHeader,
      body: { schema, value, profileId, model },
    }),
    [server.url, authHeader, schema, value, profileId, model],
  )
  const chat = useChat({ transport, onError: (error) => console.error("Form builder chat failed", error) })
  const busy = chat.status === "submitted" || chat.status === "streaming"

  React.useEffect(() => {
    if (open) {
      setPreview(value)
      chat.setMessages([])
      setInput("")
    } else {
      void chat.stop()
    }
  // A fresh builder starts with the current form draft each time it opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    const text = input.trim()
    if (!text || busy) return
    setInput("")
    await chat.sendMessage({ text })
  }

  const toolValues = React.useMemo(() => {
    const values: Record<string, unknown>[] = []
    for (const message of chat.messages) {
      for (const part of message.parts) {
        if (part.type !== "tool-submit_form") continue
        if (part.state === "input-streaming" && part.input && typeof part.input === "object" && !Array.isArray(part.input)) {
          values.push(part.input as Record<string, unknown>)
        } else if (part.state === "input-available" && part.input && typeof part.input === "object" && !Array.isArray(part.input)) {
          values.push(part.input as Record<string, unknown>)
        } else if (part.state === "output-available" && part.output && typeof part.output === "object" && !Array.isArray(part.output)) {
          values.push(part.output as Record<string, unknown>)
        }
      }
    }
    return values
  }, [chat.messages])
  const generated = toolValues.at(-1) ?? null
  const canApply = chat.messages.some((message) => message.parts.some(
    (part) => part.type === "tool-submit_form" && part.state === "output-available",
  ))
  const schemaErrors = React.useMemo(() => validateSchema(schema, generated), [schema, generated])

  React.useEffect(() => {
    if (generated) setPreview(generated)
  }, [generated])

  const apply = () => {
    const candidate = generated
    if (candidate && schemaErrors.length === 0) onApply(candidate)
  }

  /* Captured once per failure, not per render: `captureError` logs. */
  const chatError = React.useMemo(
    () => (chat.error ? captureError(chat.error, "The assistant couldn't answer") : null),
    [chat.error],
  )

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} tall>
      <ResponsiveDialogContent
        className="h-[min(calc(var(--float-h)-2rem),54rem)] sm:max-w-5xl"
        bodyClassName="gap-0 overflow-hidden p-0"
      >
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Build {title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Describe what you want, review the JSON, then apply it to the form.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col @2xl/panel:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <PanelToolbar>
              <h3 className="text-xs font-medium text-muted-foreground">Conversation</h3>
            </PanelToolbar>
            <ScrollArea className="min-h-0 flex-1 p-3">
              <div className="space-y-3">
                {chat.messages.length === 0 && (
                  <Empty size="sm">
                    Tell the assistant what you are trying to configure — the intended behaviour and any constraints.
                    It reads this form's schema and current values. Change its model in Settings › AI helpers.
                  </Empty>
                )}
                {chat.messages.map((message) => (
                  <div key={message.id} className={cn("flex gap-2", message.role === "user" && "justify-end")}>
                    {message.role !== "user" && <Bot className="mt-1 size-4 shrink-0 text-muted-foreground" />}
                    <div className={cn("max-w-[88%] rounded-xl px-3 py-2 text-sm", message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted")}>
                      {message.parts.map((part, index) => part.type === "text" ? <p key={index} className="whitespace-pre-wrap">{part.text}</p> : null)}
                    </div>
                  </div>
                ))}
                {busy && <p aria-live="polite" className="animate-pulse text-sm text-muted-foreground">Updating the form…</p>}
                <ErrorNote error={chatError} />
              </div>
            </ScrollArea>
            <form onSubmit={send} className="flex items-end gap-2 border-t p-3">
              <Textarea value={input} onChange={(event) => setInput(event.target.value)} rows={2} placeholder="Describe the values or ask for a change…" className="max-h-28 min-h-10 resize-y" />
              {busy ? (
                <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={() => void chat.stop()}>Stop</Button>
              ) : (
                <Button type="submit" size="icon" className="pointer-coarse:size-11" aria-label="Send message" disabled={!input.trim()}><Send /></Button>
              )}
            </form>
          </section>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col border-t @2xl/panel:border-t-0 @2xl/panel:border-l">
            <PanelToolbar className="justify-between">
              <h3 className="text-xs font-medium text-muted-foreground">Live JSON preview</h3>
              {generated && <Badge variant="secondary">Generated</Badge>}
            </PanelToolbar>
            <ScrollArea className="min-h-0 flex-1 p-3">
              <pre className="min-h-full whitespace-pre-wrap break-words rounded-xl border bg-muted/50 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(preview, null, 2)}</pre>
            </ScrollArea>
          </section>
        </div>
        <ResponsiveDialogFooter>
          <p className="min-w-0 self-center text-sm text-muted-foreground sm:mr-auto">
            {schemaErrors.length > 0 ? <span className="text-destructive">{schemaErrors[0]}</span> : "Apply replaces the draft only; saving is still yours."}
          </p>
          <Button type="button" onClick={apply} disabled={!canApply || schemaErrors.length > 0}>Apply values</Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
