import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { useRules, useCreateRule, useUpdateRule, useDeleteRule } from "@/lib/queries/catalog"
import { captureError, type InlineError } from "@/lib/errors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Field, FormActions, INSET, PageForm, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"
import { useSettingsPage } from "./layout"

/* ── Rules ──
   Individual standing instructions every thread spawns with —
   beneath any project's own rules and above its persona, folded
   into the spawn by server/src/rules.ts through the door each
   runtime already opens. Each rule has a title and content so
   they can be managed individually rather than as one blob. */

export function RulesPage() {
  const { settings } = useSettingsPage()
  const meta = sectionMeta("rules")
  const rules = useRules()
  const createRule = useCreateRule()
  const updateRule = useUpdateRule()
  const deleteRule = useDeleteRule()
  const [error, setError] = React.useState<InlineError | null>(null)

  const addRule = () => {
    createRule.mutate(
      { projectId: null, title: "New rule", content: "" },
      {
        onError: (err) => setError(captureError(err, "Couldn't add a rule")),
      },
    )
  }

  const updateField = (id: string, field: "title" | "content", value: string) => {
    updateRule.mutate({ id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the rule")),
    })
  }

  const removeRule = (id: string) => {
    deleteRule.mutate({ id }, {
      onError: (err) => setError(captureError(err, "Couldn't delete the rule")),
    })
  }

  const moveRule = (id: string, direction: "up" | "down") => {
    const idx = rules.findIndex((r) => r.id === id)
    if (idx === -1) return
    const swapIdx = direction === "up" ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rules.length) return
    const [a, b] = [rules[idx], rules[swapIdx]]
    updateRule.mutate(
      { id: a.id, sortOrder: b.sortOrder },
      { onError: (err) => setError(captureError(err, "Couldn't reorder rules")) },
    )
    updateRule.mutate(
      { id: b.id, sortOrder: a.sortOrder },
      { onError: (err) => setError(captureError(err, "Couldn't reorder rules")) },
    )
  }

  return (
    <>
      <PageHeader meta={meta} action={
        <Button onClick={addRule} disabled={createRule.isPending}>
          <Plus className="size-4" /> Add rule
        </Button>
      } />
      <PageForm onSubmit={(e) => e.preventDefault()}>
        {error && <p className="text-xs text-destructive">{error.text}</p>}
        <div className="space-y-3">
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet. Add one to get started.</p>
          ) : (
            rules.map((rule, idx) => (
              <div key={rule.id} className={cn("space-y-2 p-3", INSET)}>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => moveRule(rule.id, "up")}
                    disabled={idx === 0}
                    title="Move up"
                  >
                    ▲
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => moveRule(rule.id, "down")}
                    disabled={idx === rules.length - 1}
                    title="Move down"
                  >
                    ▼
                  </Button>
                  <Input
                    value={rule.title}
                    onChange={(e) => updateField(rule.id, "title", e.target.value)}
                    placeholder="Rule title"
                    className="font-medium"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeRule(rule.id)}
                    title="Delete rule"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Textarea
                  value={rule.content}
                  onChange={(e) => updateField(rule.id, "content", e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder="Standing instruction for the agent…"
                />
              </div>
            ))
          )}
        </div>
        <FormActions busy={createRule.isPending} error={error} />
      </PageForm>
    </>
  )
}
