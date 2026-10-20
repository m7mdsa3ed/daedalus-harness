import * as React from "react"
import { Navigate, useNavigate, useParams } from "react-router"
import { Plus, Tag, Trash2 } from "lucide-react"
import {
  useModelRoles,
  useCreateModelRole,
  useUpdateModelRole,
  useDeleteModelRole,
} from "@/lib/queries/model-roles"
import { captureError, inlineFromQuery, type InlineError } from "@/lib/errors"
import { useServer } from "@/lib/server-context"
import { modelRolesKey } from "@/lib/queries/keys"
import { useApiQuery } from "@/lib/queries/helpers"
import { Empty } from "@/components/empty"
import type { ModelRole } from "@/lib/settings"
import type { ColumnDef } from "@/lib/table"
import { useIsNarrow } from "@/hooks/use-device"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { DataTable, type TableAction } from "@/components/ui/data-table"
import { useTableFilter } from "@/lib/use-table-filter"
import { ErrorNote } from "@/components/error-note"
import { settingsFormPath, settingsPath } from "@/lib/router"
import { Field, FormActions, FormPageHeader, FormSection, PageForm, PageHeader, Section, StatusBadge } from "./primitives"
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
   answers for.

   Layout: header, then one DataTable — Role (label edited in place, id under
   it) | Description (edited in place) | Status (a warn StatusBadge on a role
   with no description). "New role" is the page header's action and opens the
   the same page (`ModelRoleFormPage`, /settings/model-roles/:entryId, "new" =
   add) a phone row opens to edit, where the inline inputs would be too small to
   aim at. Label and description save on change, as they always did. */

const INPUT = "pointer-coarse:h-11"
const UNSET = "border-dashed"

export function ModelRolesPage() {
  const meta = sectionMeta("model-roles")
  const roles = useModelRoles()
  /* The same key and route the list hook reads, so this is its state, not a
     second request: "not yet" and "could not read" are not "no roles". */
  const state = useApiQuery<ModelRole[]>(modelRolesKey(useServer()), "/api/model-roles", { staleTime: 60_000 })
  const updateRole = useUpdateModelRole()
  const deleteRole = useDeleteModelRole()
  const [error, setError] = React.useState<InlineError | null>(null)
  const navigate = useNavigate()

  /* The panel's width picks the rows (inline inputs / tap-to-edit), the same
     measurement the table uses to choose between its two layouts. */
  const rootRef = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(rootRef)

  const { mutate: updateMutate } = updateRole
  const { mutate: deleteMutate } = deleteRole

  const updateField = React.useCallback(
    (id: string, field: "label" | "description", value: string) => {
      updateMutate({ id, [field]: value }, {
        onError: (err) => setError(captureError(err, "Couldn't update the role")),
      })
    },
    [updateMutate],
  )

  const removeRole = React.useCallback(
    (id: string) => {
      deleteMutate({ id }, {
        onError: (err) => setError(captureError(err, "Couldn't delete the role")),
      })
    },
    [deleteMutate],
  )

  const f = useTableFilter(roles, {
    text: (r) => `${r.id} ${r.label} ${r.description}`,
    placeholder: "Search roles…",
    fields: [{ id: "description", label: "Description", of: (r) => (r.description.trim() ? "Described" : "No description") }],
  })
  const unset = roles.filter((r) => !r.description.trim()).length

  /* Desktop: label and description edit in the cells. The table memoises a row
     against these, so they are rebuilt only when a handler changes. */
  const columns = React.useMemo<ColumnDef<ModelRole, unknown>[]>(
    () => [
      {
        id: "role",
        header: "Role",
        meta: { title: true, className: "w-[18rem]" },
        cell: ({ row }) => {
          const role = row.original
          return (
            <div className="min-w-0 space-y-1 py-0.5">
              <SavedInput
                value={role.label}
                onSave={(v) => updateField(role.id, "label", v)}
                placeholder="Role label"
                aria-label={`Label for ${role.id}`}
                className={cn(INPUT, "font-medium")}
              />
              <Badge variant="secondary" className="max-w-full truncate font-mono" title={role.id}>
                {role.id}
              </Badge>
            </div>
          )
        },
      },
      {
        id: "description",
        header: "Description",
        cell: ({ row }) => {
          const role = row.original
          return (
            <SavedInput
              value={role.description}
              onSave={(v) => updateField(role.id, "description", v)}
              placeholder="One line for the agent — e.g. Cheap side-jobs"
              aria-label={`Description for ${role.id}`}
              className={cn(INPUT, !role.description.trim() && UNSET)}
            />
          )
        },
      },
      {
        id: "status",
        header: "Status",
        meta: { align: "end", className: "w-32" },
        cell: ({ row }) => <RoleStatus role={row.original} />,
      },
    ],
    [updateField],
  )

  const actions = React.useMemo<TableAction<ModelRole>[]>(
    () => [
      {
        id: "delete",
        label: "Delete role",
        icon: <Trash2 />,
        tone: "danger",
        onClick: (role) => removeRole(role.id),
      },
    ],
    [removeRole],
  )

  const addButton = (
    <Button type="button" onClick={() => void navigate(settingsFormPath("model-roles"))}>
      <Plus data-icon="inline-start" /> New role
    </Button>
  )

  return (
    <div ref={rootRef}>
      <PageHeader meta={meta} action={addButton} />
      {error && (
        <Section>
          <ErrorNote error={error} />
        </Section>
      )}
      {state.error ? (
        <Section>
          <ErrorNote error={inlineFromQuery(state.error, "Couldn't read the model roles")} onRetry={() => void state.refetch()} />
        </Section>
      ) : roles.length === 0 && !state.isPending ? (
        <Empty size="lg" icon={Tag} action={<div className="[&_[data-slot=button]]:pointer-coarse:h-11">{addButton}</div>}>
          No roles yet.
        </Empty>
      ) : (
        <Section
          label="Roles"
          count={state.isPending ? undefined : roles.length}
          hint={`${unset ? `${unset} without a description. ` : ""}A role with no description has a dashed edge — the agent has nothing to choose it by.`}
        >
          <DataTable
            columns={columns}
            data={f.rows}
            getRowId={(r) => r.id}
            isLoading={state.isPending}
            pageSize={25}
            actions={actions}
            mark={() => <Tag />}
            filtering={f.filtering}
            emptyIcon={<Tag />}
            onRowClick={narrow ? (r) => void navigate(settingsFormPath("model-roles", r.id)) : undefined}
            mobile={{ renderRow: (role) => <RoleRow role={role} /> }}
          />
        </Section>
      )}
    </div>
  )
}

/** Add a role ("new") or edit the one the route names. */
export function ModelRoleFormPage() {
  const { entryId } = useParams()
  const navigate = useNavigate()
  const roles = useModelRoles()
  const createRole = useCreateModelRole()
  const updateRole = useUpdateModelRole()
  const deleteRole = useDeleteModelRole()
  const [error, setError] = React.useState<InlineError | null>(null)
  /* The "add" form's fields. `id` is optional: the server mints a stable one
     when it is left empty. */
  const [draftId, setDraftId] = React.useState("")
  const [draftLabel, setDraftLabel] = React.useState("")
  const [draftDescription, setDraftDescription] = React.useState("")
  const adding = entryId === "new"
  const editing = adding ? undefined : roles.find((r) => r.id === entryId)
  /* An unknown id, or a role deleted from under the page (another device). */
  if (!adding && !editing) return <Navigate to={settingsPath("model-roles")} replace />
  const back = () => void navigate(settingsPath("model-roles"))

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
        onSuccess: back,
        onError: (err) => setError(captureError(err, "Couldn't add the role")),
      },
    )
  }
  const save = (id: string, field: "label" | "description", value: string) =>
    updateRole.mutate({ id, [field]: value }, {
      onError: (err) => setError(captureError(err, "Couldn't update the role")),
    })

  return (
    <>
      <FormPageHeader
        title={editing ? "Edit role" : "Add a role"}
        description={
          editing
            ? `${editing.id} cannot be renamed; label and description save as you type.`
            : "Id is optional and cannot change once the role exists; leave it empty and the server mints one."
        }
        onBack={back}
      />
      {editing ? (
        <PageForm onSubmit={(e) => e.preventDefault()}>
          <FormSection label="Role">
            <Field label="Label">
              <SavedInput
                value={editing.label}
                onSave={(v) => save(editing.id, "label", v)}
                placeholder="Role label"
                aria-label={`Label for ${editing.id}`}
                className={cn(INPUT, "font-medium")}
              />
            </Field>
            <Field label="Description">
              <SavedInput
                value={editing.description}
                onSave={(v) => save(editing.id, "description", v)}
                placeholder="One line for the agent — e.g. Cheap side-jobs"
                aria-label={`Description for ${editing.id}`}
                className={cn(INPUT, !editing.description.trim() && UNSET)}
              />
            </Field>
          </FormSection>
          <FormActions
            busy={false}
            error={error}
            done={back}
            leading={
              <Button
                variant="outline"
                type="button"
                className="text-destructive"
                onClick={() =>
                  deleteRole.mutate(
                    { id: editing.id },
                    {
                      onSuccess: back,
                      onError: (err) => setError(captureError(err, "Couldn't delete the role")),
                    },
                  )
                }
                aria-label={`Delete role ${editing.id}`}
              >
                <Trash2 data-icon="inline-start" />
                Delete role
              </Button>
            }
          />
        </PageForm>
      ) : (
        <PageForm
          onSubmit={(e) => {
            e.preventDefault()
            addRole()
          }}
        >
          <FormSection label="Role">
            <Field label="Id">
              <Input
                value={draftId}
                onChange={(e) => setDraftId(e.target.value)}
                placeholder="Id (optional) — small"
                title="Optional. What a model's assignment points at; it cannot be changed once the role exists. Leave empty and the server mints one."
                aria-label="Id"
                className={cn(INPUT, "font-mono")}
              />
            </Field>
            <Field label="Label">
              <Input
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                placeholder="Label — Small"
                aria-label="Label"
                className={INPUT}
                required
              />
            </Field>
            <Field label="Description">
              <Input
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder="Description — Cheap side-jobs"
                aria-label="Description"
                className={INPUT}
              />
            </Field>
          </FormSection>
          <FormActions busy={createRole.isPending} onCancel={back} error={error} submitLabel="Add role" />
        </PageForm>
      )}
    </>
  )
}

/** An input over a value the server owns: typing is kept locally (the save is
    not optimistic, so a bound value would snap each character back until the
    refetch lands) and the server's value is taken again once focus leaves.
    Clicks stop here so a cell input never opens the row. */
function SavedInput({
  value,
  onSave,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string
  onSave: (value: string) => void
}) {
  const [local, setLocal] = React.useState(value)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setLocal(value)
  }, [value])
  return (
    <Input
      {...props}
      value={local}
      onChange={(e) => {
        setLocal(e.target.value)
        onSave(e.target.value)
      }}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        setLocal(value)
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

/** The status cell: warn when the agent has nothing to choose the role by. */
function RoleStatus({ role }: { role: ModelRole }) {
  return role.description.trim() ? (
    <StatusBadge tone="ok">Ready</StatusBadge>
  ) : (
    <StatusBadge tone="warn">No description</StatusBadge>
  )
}

/** A role on a phone: read-only (tap to edit), mark + label + description,
    the id and status beneath. */
function RoleRow({ role }: { role: ModelRole }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Tag className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{role.label || role.id}</div>
        <div
          className={cn(
            "truncate text-sm",
            role.description.trim() ? "text-muted-foreground" : "italic text-muted-foreground",
          )}
        >
          {role.description.trim() || "No description"}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{role.id}</div>
      </div>
    </div>
  )
}
