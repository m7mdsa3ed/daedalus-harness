import * as React from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { Bot, LoaderCircle, Send, Sparkles, WandSparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import type { ServerSettings } from "@/lib/settings"
import { useProfiles } from "@/lib/queries/catalog"
import { aiCapable, formBuilderPick } from "@/lib/ai-picks"
import { useServer } from "@/lib/server-context"
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
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!profile}>
        <WandSparkles /> Fill with AI
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(calc(var(--float-h)-2rem),54rem)] flex-col gap-4 overflow-hidden sm:max-w-6xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Build {title}</DialogTitle>
          <DialogDescription>Describe what you want. The assistant uses this form's schema and current values; review the JSON before applying it. Change the model in Settings, AI helpers.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border bg-card">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="text-xs font-medium">Conversation</span>
            </div>
            <ScrollArea className="min-h-0 flex-1 p-3">
              <div className="space-y-3">
                {chat.messages.length === 0 && <div className="rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">Tell the assistant what you are trying to configure. For example, describe the intended behavior and any constraints.</div>}
                {chat.messages.map((message) => (
                  <div key={message.id} className={cn("flex gap-2", message.role === "user" && "justify-end")}>
                    {message.role !== "user" && <Bot className="mt-1 size-4 shrink-0 text-muted-foreground" />}
                    <div className={cn("max-w-[88%] rounded-xl px-3 py-2 text-sm", message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted/60")}>
                      {message.parts.map((part, index) => part.type === "text" ? <p key={index} className="whitespace-pre-wrap">{part.text}</p> : null)}
                    </div>
                  </div>
                ))}
                {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> Updating the form…</div>}
                {chat.error && <p role="alert" className="text-sm text-destructive">{chat.error.message}</p>}
              </div>
            </ScrollArea>
            <form onSubmit={send} className="flex items-end gap-2 border-t p-3">
              <Textarea value={input} onChange={(event) => setInput(event.target.value)} rows={2} placeholder="Describe the values or ask for a change…" className="max-h-28 min-h-10 resize-y" />
              {busy ? <Button type="button" variant="outline" onClick={() => void chat.stop()}>Stop</Button> : <Button type="submit" size="icon" aria-label="Send message" disabled={!input.trim()}><Send /></Button>}
            </form>
          </section>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <div><div className="text-xs font-medium">Live JSON preview</div><div className="text-[11px] text-muted-foreground">Current form contract</div></div>
              {generated && <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] text-primary">Generated</span>}
            </div>
            <ScrollArea className="min-h-0 flex-1 p-3"><pre className="min-h-full whitespace-pre-wrap break-words rounded-xl bg-muted/50 p-3 font-mono text-xs leading-relaxed">{JSON.stringify(preview, null, 2)}</pre></ScrollArea>
            <div className="flex flex-col gap-2 border-t p-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                {schemaErrors.length > 0 ? <span className="text-destructive">{schemaErrors[0]}</span> : "Apply replaces the draft only; saving is still yours."}
              </div>
              <Button type="button" onClick={apply} disabled={!canApply || schemaErrors.length > 0}>Apply values</Button>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
