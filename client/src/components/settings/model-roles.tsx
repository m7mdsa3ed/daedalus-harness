import * as React from "react"
import { Plus, Tag, Trash2 } from "lucide-react"
import {
  useModelRoles,
  useCreateModelRole,
  useUpdateModelRole,
  useDeleteModelRole,
} from "@/lib/queries/model-roles"
import { captureError, type InlineError } from "@/lib/errors"
import type { ModelRole } from "@/lib/settings"
import type { ColumnDef } from "@/lib/table"
import { useIsNarrow } from "@/hooks/use-device"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { DataTable, type TableAction } from "@/components/ui/data-table"
import { ErrorNote } from "@/components/error-note"
import { DetailSheet, Field, PageHeader, Section, StatusBadge } from "./primitives"
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
   same DetailSheet a phone row opens to edit: a right sheet on a wide panel,
   a bottom sheet on a phone, where the inline inputs would be too small to aim at.
   Label and description save on change, as they always did. */

const INPUT = "text-xs pointer-coarse:h-11"
const UNSET = "border-dashed"

/** The dialog is either adding a role or editing the one it names. */
type Sheet = { kind: "add" } | { kind: "edit"; id: string } | null

export function ModelRolesPage() {
  const meta = sectionMeta("model-roles")
  const roles = useModelRoles()
  const createRole = useCreateModelRole()
  const updateRole = useUpdateModelRole()
  const deleteRole = useDeleteModelRole()
  const [error, setError] = React.useState<InlineError | null>(null)
  const [sheet, setSheet] = React.useState<Sheet>(null)
  const [query, setQuery] = React.useState("")

  /* The panel's width picks the rows (inline inputs / tap-to-edit), the same
     measurement the table uses to choose between its two layouts. */
  const rootRef = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(rootRef)

  /* The "add" form's fields. `id` is optional: the server mints a stable one
     when it is left empty. */
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
          setSheet(null)
        },
        onError: (err) => setError(captureError(err, "Couldn't add the role")),
      },
    )
  }

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

  const needle = query.trim().toLowerCase()
  const shown = React.useMemo(
    () =>
      needle
        ? roles.filter((r) =>
            `${r.id} ${r.label} ${r.description}`.toLowerCase().includes(needle),
          )
        : roles,
    [roles, needle],
  )
  const editingId = sheet?.kind === "edit" ? sheet.id : null
  const editing = editingId ? roles.find((r) => r.id === editingId) : undefined
  /* The role was deleted from under the sheet (another device): close it. */
  React.useEffect(() => {
    if (editingId && !editing) setSheet(null)
  }, [editingId, editing])
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
              <Badge variant="secondary" className="max-w-full truncate font-mono text-[11px]" title={role.id}>
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
        icon: <Trash2 className="size-4" />,
        tone: "danger",
        onClick: (role) => removeRole(role.id),
      },
    ],
    [removeRole],
  )

  const addButton = (
    <Button type="button" className="h-11 @panel-sm:h-9" onClick={() => setSheet({ kind: "add" })}>
      <Plus className="size-4" /> New role
    </Button>
  )

  return (
    <div ref={rootRef}>
      <PageHeader meta={meta} action={addButton} />
      <ErrorNote error={error} />

      <Section
        label="Roles"
        hint={`${roles.length} ${roles.length === 1 ? "role" : "roles"}${unset ? `, ${unset} without a description` : ""}. A role with no description has a dashed edge — the agent has nothing to choose it by.`}
      >
        <DataTable
          columns={columns}
          data={shown}
          getRowId={(r) => r.id}
          pageSize={25}
          actions={actions}
          mark={() => <Tag />}
          viewToggle={false}
          filtering={{
            search: { value: query, onChange: setQuery, placeholder: "Search roles…" },
            totalCount: roles.length,
          }}
          emptyIcon={<Tag />}
          emptyMessage={needle ? `Nothing matches “${query.trim()}”.` : "No roles yet."}
          emptyAction={needle ? undefined : addButton}
          onRowClick={narrow ? (r) => setSheet({ kind: "edit", id: r.id }) : undefined}
          mobile={{ renderRow: (role) => <RoleRow role={role} /> }}
        />
      </Section>

      <DetailSheet
        open={sheet !== null}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet?.kind === "add" ? "Add a role" : "Edit role"}
        description={
          sheet?.kind === "add"
            ? "Id is optional and cannot change once the role exists; leave it empty and the server mints one."
            : editing && (
                <>
                  <Badge variant="secondary" className="max-w-full truncate font-mono text-[11px]">
                    {editing.id}
                  </Badge>{" "}
                  cannot be renamed; label and description save as you type.
                </>
              )
        }
        footer={
          sheet?.kind === "add" ? (
            <>
              <Button variant="outline" type="button" onClick={() => setSheet(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-role"
                disabled={createRole.isPending || !draftLabel.trim()}
                title="Add role"
              >
                <Plus className="size-4" />
                Add role
              </Button>
            </>
          ) : (
            editing && (
              <>
                <Button
                  variant="outline"
                  type="button"
                  className="text-destructive"
                  onClick={() => {
                    removeRole(editing.id)
                    setSheet(null)
                  }}
                  aria-label={`Delete role ${editing.id}`}
                >
                  <Trash2 className="size-4" />
                  Delete role
                </Button>
                <Button type="button" onClick={() => setSheet(null)}>
                  Done
                </Button>
              </>
            )
          )
        }
      >
        {sheet?.kind === "add" && (
          <form
            id="add-role"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              addRole()
            }}
          >
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
          </form>
        )}
        {sheet?.kind === "edit" && editing && (
          <>
            <Field label="Label">
              <SavedInput
                value={editing.label}
                onSave={(v) => updateField(editing.id, "label", v)}
                placeholder="Role label"
                aria-label={`Label for ${editing.id}`}
                className={cn(INPUT, "font-medium")}
              />
            </Field>
            <Field label="Description">
              <SavedInput
                value={editing.description}
                onSave={(v) => updateField(editing.id, "description", v)}
                placeholder="One line for the agent — e.g. Cheap side-jobs"
                aria-label={`Description for ${editing.id}`}
                className={cn(INPUT, !editing.description.trim() && UNSET)}
              />
            </Field>
          </>
        )}
      </DetailSheet>
    </div>
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
            "truncate text-xs",
            role.description.trim() ? "text-muted-foreground" : "italic text-muted-foreground/70",
          )}
        >
          {role.description.trim() || "No description"}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/80">{role.id}</div>
      </div>
    </div>
  )
}
