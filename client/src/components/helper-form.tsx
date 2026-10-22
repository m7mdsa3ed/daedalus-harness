import * as React from "react"
import { ChevronRight, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Field, INSET } from "@/components/settings/primitives"
import { reportError } from "@/lib/errors"
import { useAddHelper, useUpdateHelper } from "@/lib/queries/surfaces"
import type { HelperCommand } from "@/lib/settings"
import type { HelperInput } from "@/lib/workspace/project-helpers"
import { cn } from "@/lib/utils"

/** `KEY=value` per line — friendlier to type than JSON, lossless to parse. */
function parseEnvText(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    const key = eq === -1 ? "" : line.slice(0, eq).trim()
    if (!key) return null
    out[key] = line.slice(eq + 1).trim()
  }
  return out
}

/** A switch row whose whole width is the hit area — a label, so a tap on the
    words flips it too, and 44px tall under a coarse pointer. */
function ToggleRow({
  title,
  hint,
  checked,
  onChange,
}: {
  title: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 pointer-coarse:min-h-14">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </label>
  )
}

/**
 * One project helper command, added or edited. Owns its fields and the write;
 * the caller remounts it (`key`) to start over. Shared by Settings › Projects
 * and the composer's `!` menu, whose save button opens it prefilled with the
 * line that was run — so a command saved from either is the same row.
 *
 * **Name and command are the form; the rest is folded** under "More options",
 * which says in one line what is set. Most helpers are those two fields, and
 * on a phone seven stacked fields put Save a long scroll away.
 *
 * `actions={false}` drops the inline buttons for a caller whose own footer
 * submits it by `id` — a dialog's, which stays pinned above the keyboard.
 */
export function HelperForm({
  id,
  projectId,
  initial,
  onDone,
  onCancel,
  onBusyChange,
  actions = true,
  className,
  autoFocus,
}: {
  id?: string
  projectId: string
  /** An existing helper (with `id`) is edited; anything else prefills a new one. */
  initial?: Partial<HelperCommand>
  onDone: () => void
  onCancel?: () => void
  onBusyChange?: (busy: boolean) => void
  actions?: boolean
  className?: string
  autoFocus?: boolean
}) {
  const editingId = initial?.id ?? null
  const addHelper = useAddHelper()
  const updateHelper = useUpdateHelper()
  const [saving, setSavingState] = React.useState(false)
  const setSaving = (busy: boolean) => {
    setSavingState(busy)
    onBusyChange?.(busy)
  }
  const [name, setName] = React.useState(initial?.name ?? "")
  const [command, setCommand] = React.useState(initial?.command ?? "")
  const [description, setDescription] = React.useState(initial?.description ?? "")
  const [cwd, setCwd] = React.useState(initial?.cwd ?? "")
  const [envText, setEnvText] = React.useState(
    initial?.env ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join("\n") : ""
  )
  const [confirm, setConfirm] = React.useState(initial?.confirm ?? false)
  const [envProblem, setEnvProblem] = React.useState<string | null>(null)
  // What the fold holds, said on its trigger so a closed fold still tells.
  const extras = [
    description.trim() && "description",
    cwd.trim() && `in ${cwd.trim()}`,
    envText.trim() && "env",
    confirm && "asks first",
  ].filter(Boolean) as string[]
  const [more, setMore] = React.useState(extras.length > 0)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    // The dialog's form sits inside the composer's: never submit that one too.
    e.stopPropagation()
    if (saving) return
    const trimmedName = name.trim()
    const trimmedCmd = command.trim()
    if (!trimmedName || !trimmedCmd) return
    const env = parseEnvText(envText)
    if (env === null) {
      setMore(true)
      setEnvProblem("Some lines aren't KEY=value — fix them to save.")
      return
    }
    setEnvProblem(null)
    const input: HelperInput = {
      name: trimmedName,
      command: trimmedCmd,
      description: description.trim() || null,
      cwd: cwd.trim() || null,
      env: Object.keys(env).length > 0 ? env : null,
      confirm,
    }
    setSaving(true)
    try {
      if (editingId) await updateHelper.mutateAsync({ projectId, helperId: editingId, input })
      else await addHelper.mutateAsync({ projectId, input })
      onDone()
    } catch (err) {
      reportError(err, editingId ? "Couldn't update helper command" : "Couldn't add helper command")
    } finally {
      setSaving(false)
    }
  }

  return (
    <form id={id} onSubmit={save} className={cn("space-y-4", className)}>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Restart server, Run migrations…"
          autoFocus={autoFocus}
          enterKeyHint="next"
          required
        />
      </Field>
      <Field label="Command" hint="Runs in a terminal panel, so a command that asks something can be answered.">
        {/* A textarea that grows, so a long line wraps where a phone can read
            all of it; Enter still saves, because a shell line is one line. */}
        <Textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder="npm run db:migrate"
          rows={1}
          enterKeyHint="done"
          className="min-h-0 py-2 font-mono break-all"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          required
        />
      </Field>
      <Collapsible open={more} onOpenChange={setMore} className={INSET}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left pointer-coarse:min-h-11">
          <ChevronRight
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", more && "rotate-90")}
          />
          <span className="text-sm font-medium">More options</span>
          {!more && extras.length > 0 && (
            <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
              {extras.join(" · ")}
            </span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 border-t px-3 pt-3 pb-1">
          <Field label="Description" hint="Shown in the Run menu and before the command runs.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this command does"
            />
          </Field>
          <Field label="Working directory" hint="Project-relative. Empty = the project root.">
            <Input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="packages/server"
              className="font-mono"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </Field>
          <Field label="Environment" hint="One variable per line, KEY=value.">
            <Textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"DATABASE_URL=postgres://localhost/app\nNODE_ENV=development"}
              rows={2}
              aria-invalid={envProblem ? true : undefined}
              className="min-h-0 font-mono"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {envProblem && <p className="text-sm text-destructive">{envProblem}</p>}
          </Field>
          <div className="-mx-3 divide-y border-t">
            <ToggleRow
              title="Ask before running"
              hint="Confirm before its terminal opens — for the destructive ones."
              checked={confirm}
              onChange={setConfirm}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {actions && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={saving} disabled={!name.trim() || !command.trim()}>
            <Plus data-icon="inline-start" /> {editingId ? "Save changes" : "Add command"}
          </Button>
        </div>
      )}
    </form>
  )
}
