import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  useModelRoles,
  useCreateModelRole,
  useUpdateModelRole,
  useDeleteModelRole,
} from "@/lib/queries/model-roles"
import { captureError, type InlineError } from "@/lib/errors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Field, FormActions, Group, INSET, PageForm, PageHeader } from "./primitives"
import { sectionMeta } from "./sections"

/* ── Model roles ──
   The free-form, ordered vocabulary a profile's models tag themselves with, so
   a subagent is spawned on a role ("small", "advisor") rather than on a
   hardcoded "small" model (docs/model-roles.md). Global, one list per server,
   the same shape the Rules section takes.

   `id` is what an assignment points at and is stable, so a rename must not
   change it: the id is named when the role is *added*, and read-only afterwards
   (`updateModelRole` cannot change it). `label` and `description` are what a
   person reads and stay editable. A deleted role leaves dangling tags on the
   profiles that carried it on purpose — the readers ignore an id no row
   answers for. */

export function ModelRolesPage() {
  const meta = sectionMeta("model-roles")
  const roles = useModelRoles()
  const createRole = useCreateModelRole()
  const updateRole = useUpdateModelRole()
  const deleteRole = useDeleteModelRole()
  const [error, setError] = React.useState<InlineError | null>(null)

  /* The inline "add" form's fields. `id` is optional: the server mints a stable
     one when it is left empty. */
  const [draftId, setDraftId] = React.useState("")
  const [draftLabel, setDraftLabel] = React.useState("")
  const [draftDescription, setDraftDescription] = React.useState("")

  const addRole = () => {
    const label = draftLabel.trim()
    if (!label) return
    createRole.mutate(
      {
        ...(draftId.trim() ? { id: draftId.trim() } : {}),
        label,
        description: draftDescription.trim(),
      },
      {
        onSuccess: () => {
          setDraftId("")
          setDraftLabel("")
          setDraftDescription("")
        },
        onError: (err) => setError(captureError(err, "Couldn't add the role")),
      },
    )
  }

  const updateField = (id: string, field: "label" | "description", value: string) => {
    updateRole.mutate({ id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the role")),
    })
  }

  const removeRole = (id: string) => {
    deleteRole.mutate({ id }, {
      onError: (err) => setError(captureError(err, "Couldn't delete the role")),
    })
  }

  return (
    <>
      <PageHeader meta={meta} />
      <PageForm onSubmit={(e) => e.preventDefault()}>
        {error && <p className="text-xs text-destructive">{error.text}</p>}

        <Group
          label="Add a role"
          hint="Id is optional — leave it empty and the server mints one. It is what a model's assignment points at, so it cannot be changed once the role exists; the label is what people read."
        >
          <div className="grid gap-3 py-3 @panel-sm:grid-cols-3">
            <Field label="Id">
              <Input
                value={draftId}
                onChange={(e) => setDraftId(e.target.value)}
                placeholder="small"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Label">
              <Input
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                placeholder="Small"
                className="text-xs"
              />
            </Field>
            <Field label="Description">
              <Input
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="Cheap side-jobs"
                className="text-xs"
              />
            </Field>
          </div>
          <div className="flex justify-end pb-3">
            <Button
              type="button"
              onClick={addRole}
              disabled={createRole.isPending || !draftLabel.trim()}
            >
              <Plus className="size-4" /> Add role
            </Button>
          </div>
        </Group>

        <Group label="Roles">
          {roles.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              No roles yet. Add one above to get started.
            </p>
          ) : (
            roles.map((role) => (
              <div key={role.id} className="py-3">
                <div className={cn("space-y-3 p-3", INSET)}>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="shrink-0 font-mono text-[11px]">
                      {role.id}
                    </Badge>
                    <Input
                      value={role.label}
                      onChange={(e) => updateField(role.id, "label", e.target.value)}
                      placeholder="Role label"
                      className="text-xs font-medium"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={() => removeRole(role.id)}
                      title="Delete role"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Input
                    value={role.description}
                    onChange={(e) => updateField(role.id, "description", e.target.value)}
                    placeholder="One line for the agent — e.g. Cheap side-jobs"
                    className="text-xs"
                  />
                </div>
              </div>
            ))
          )}
        </Group>

        <FormActions busy={createRole.isPending} error={error} />
      </PageForm>
    </>
  )
}
