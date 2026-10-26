/* The project page's "Workflows" group: the saved workflows a project can run
   (its own and the personal ones), each with a Run button that opens the form
   generated from its `inputs` schema. Draws nothing when there are none and
   nothing when the server has no library route — a project page is not the
   place to announce a feature the install lacks. */
import * as React from "react"
import { PlayIcon, Trash2Icon, WorkflowIcon } from "lucide-react"

import { ErrorNote } from "@/components/error-note"
import { Notice } from "@/components/notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/busy-button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Group } from "@/components/settings/primitives"
import { useConfirm } from "@/components/confirm-dialog"
import { captureError, reportError, type InlineError } from "@/lib/errors"
import {
  useDeleteSavedWorkflow,
  useRunSavedWorkflow,
  useSavedWorkflows,
  type SavedWorkflow,
} from "@/lib/queries/workflows"
import { toast } from "@/lib/toast"
import { ArgsForm, argsOf, draftOf, fieldsOf, type ArgsDraft } from "./args-form"

export function SavedWorkflows({
  projectId,
  sessionId,
  onStarted,
}: {
  projectId: string
  /** The thread a run hangs on: a live thread of this project (the engine has
      no parentless run). Absent when the project has none. */
  sessionId?: string
  /** A run started: the caller takes the reader to the thread it hangs on. */
  onStarted?: (sessionId: string) => void
}) {
  const saved = useSavedWorkflows(projectId)
  const del = useDeleteSavedWorkflow(projectId)
  const confirm = useConfirm()
  const [running, setRunning] = React.useState<SavedWorkflow | null>(null)
  const list = saved.data ?? []
  if (list.length === 0) return null
  const remove = async (row: SavedWorkflow) => {
    if (!(await confirm({ title: `Delete “${row.name}”?`, description: "The saved workflow is removed from the library.", confirmLabel: "Delete", destructive: true })))
      return
    del.mutate({ id: row.id, scope: row.scope }, { onError: (error) => reportError(error, "Couldn't delete the workflow") })
  }
  return (
    <>
      <Group label="Workflows" count={list.length}>
        <ul className="divide-y">
          {list.map((row) => (
            <li key={row.id} className="-mx-3 flex min-w-0 items-center gap-2 px-3 py-2.5 @panel-sm:-mx-4 @panel-sm:px-4">
              <WorkflowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate" title={row.name}>{row.name}</span>
                  <Badge variant="outline" className="font-mono" title="Version of the saved script">
                    {row.version.slice(0, 7)}
                  </Badge>
                  {row.scope === "personal" && <Badge variant="secondary">Personal</Badge>}
                </p>
                {row.description && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
                )}
              </div>
              <Button type="button" size="xs" variant="outline" onClick={() => setRunning(row)}>
                <PlayIcon aria-hidden />
                Run
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground"
                title="Delete from the library"
                disabled={del.isPending}
                onClick={() => void remove(row)}
              >
                <Trash2Icon />
                <span className="sr-only">Delete {row.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      </Group>
      {running && (
        <RunDialog
          key={running.id}
          workflow={running}
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setRunning(null)}
          onStarted={(id) => {
            setRunning(null)
            onStarted?.(id)
          }}
        />
      )}
    </>
  )
}

function RunDialog({
  workflow,
  projectId,
  sessionId,
  onClose,
  onStarted,
}: {
  workflow: SavedWorkflow
  projectId: string
  sessionId?: string
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const fields = React.useMemo(() => fieldsOf(workflow.inputs), [workflow.inputs])
  const [draft, setDraft] = React.useState<ArgsDraft>(() => draftOf(fields))
  const [error, setError] = React.useState<InlineError | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const run = useRunSavedWorkflow(projectId)
  const submit = () => {
    const args = argsOf(fields, draft)
    if (!args.ok) {
      setFormError(args.error)
      return
    }
    setFormError(null)
    setError(null)
    run.mutate(
      { name: workflow.name, ...(args.value !== undefined ? { args: args.value } : {}), ...(sessionId ? { sessionId } : {}) },
      {
        onSuccess: () => {
          toast.success(`Started “${workflow.name}”`)
          if (sessionId) onStarted(sessionId)
          else onClose()
        },
        onError: (err) => setError(captureError(err, "Couldn't start the workflow")),
      }
    )
  }
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Run {workflow.name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {workflow.description || "Starts the saved workflow in this project."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {!sessionId && (
          <p className="text-sm text-muted-foreground">
            A run hangs on a thread of this project, and there is none yet — start one first.
          </p>
        )}
        <ArgsForm fields={fields} draft={draft} onChange={setDraft} />
        {formError && <Notice tone="error">{formError}</Notice>}
        <ErrorNote error={error} />
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={run.isPending} disabled={!sessionId} onClick={submit}>
            Run
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
