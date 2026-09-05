import * as React from "react"
import { useNavigate } from "react-router"
import { Pencil, SquareTerminal } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Spinner } from "@/components/ui/spinner"
import { errorText } from "@/lib/errors"
import { settingsFormPath } from "@/lib/router"
import type { HelperCommand } from "@/lib/settings"
import { useRunHelper } from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"

/**
 * The dialog showing helper command execution and output.
 *
 * Runs the helper on open and stays open until dismissed so the user can
 * inspect stdout/stderr, execution time, and exit status.
 */
export function RunHelperDialog({
  helper,
  projectId,
  onClose,
}: {
  helper: HelperCommand
  projectId: string
  onClose: () => void
}) {
  const run = useRunHelper()
  const navigate = useNavigate()
  const [started, setStarted] = React.useState(false)

  React.useEffect(() => {
    if (started) return
    setStarted(true)
    void run.mutate({ projectId, helperId: helper.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const result = run.data
  const running = run.isPending

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="max-w-xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2 text-base">
            <SquareTerminal className="size-4 shrink-0 text-primary" />
            <span className="truncate">{helper.name}</span>
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="font-mono text-xs break-all">
            {helper.command}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="min-h-36 max-h-[60vh] overflow-y-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">
          {running ? (
            <div className="flex items-center gap-2.5 py-6 justify-center text-muted-foreground">
              <Spinner className="size-4" />
              <span>Running command… (timeout: 2m)</span>
            </div>
          ) : run.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-destructive">
              {errorText(run.error)}
            </div>
          ) : result ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between border-b pb-1.5 text-[11px]">
                <span
                  className={cn(
                    "font-semibold uppercase tracking-wider",
                    result.ok
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  )}
                >
                  {result.timedOut
                    ? "Timed out"
                    : result.ok
                      ? "Success"
                      : `Failed (exit ${String(result.exitCode ?? "?")})`}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {Math.max(1, Math.round(result.durationMs / 1000))}s
                </span>
              </div>
              <pre className={cn("whitespace-pre-wrap break-words font-mono text-xs", !result.output && "italic text-muted-foreground")}>
                {result.output || "No output returned."}
              </pre>
            </div>
          ) : (
            <span className="text-muted-foreground">Preparing to run…</span>
          )}
        </div>

        <ResponsiveDialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => {
              onClose()
              void navigate(settingsFormPath("projects", projectId))
            }}
          >
            <Pencil className="size-3.5" /> Manage helpers
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
