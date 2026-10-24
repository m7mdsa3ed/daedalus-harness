/* What a run keeps besides its steps: the `state` its script wrote, the
   artifacts it saved, and its log lines. A reading, nothing more — the
   run's own view decides what is here. */
import { FileIcon } from "lucide-react"

import { INSET } from "@/components/settings/primitives"
import { formatBytes } from "@/lib/attachments"
import type { WorkflowRunView } from "@/lib/queries/workflows"

export const hasStateOrArtifacts = (run: Pick<WorkflowRunView, "state" | "artifacts">) =>
  Object.keys(run.state).length > 0 || run.artifacts.length > 0

export function RunStatePanel({ run }: { run: Pick<WorkflowRunView, "state" | "artifacts"> }) {
  const hasState = Object.keys(run.state).length > 0
  return (
    <div className="min-w-0 space-y-3">
      {hasState && (
        <section aria-label="State">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">State</h4>
          <pre className={`${INSET} max-h-72 overflow-auto p-2 font-mono text-xs break-words whitespace-pre-wrap`}>
            {JSON.stringify(run.state, null, 2)}
          </pre>
        </section>
      )}
      {run.artifacts.length > 0 && (
        <section aria-label="Artifacts">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Artifacts</h4>
          <ul className={`${INSET} divide-y overflow-hidden`}>
            {run.artifacts.map((artifact) => (
              <li key={artifact.relPath} className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm">
                <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{artifact.name}</span>
                  <span className="block truncate text-xs text-muted-foreground" title={artifact.relPath}>
                    {artifact.relPath}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatBytes(artifact.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!hasState && run.artifacts.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing saved yet.</p>
      )}
    </div>
  )
}

export function RunLogs({ logs }: { logs: string[] }) {
  if (logs.length === 0) return <p className="text-sm text-muted-foreground">No log lines yet.</p>
  return (
    <ol className={`${INSET} max-h-72 overflow-auto p-2 font-mono text-xs`} aria-label="Log">
      {logs.map((line, i) => (
        <li key={i} className="flex gap-2 py-0.5">
          <span aria-hidden className="w-6 shrink-0 text-end tabular-nums text-muted-foreground/60">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{line}</span>
        </li>
      ))}
    </ol>
  )
}
