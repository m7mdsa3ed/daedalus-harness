/* ── Needs you: what the agents are blocked on, right now ──
   The top of the inbox, above the history. The history is what *happened*;
   this is what is *waiting* — read off every live bridge's `pending` map
   (`GET /api/pending`), so a row is here exactly as long as the agent is
   actually blocked and gone the moment anybody answers, on any device.

   Approving is the primary action, because on a phone that is the whole job:
   a permission gets its Allow and Deny right on the card, picked by ACP option
   kind (never by name), and the answer goes through the same first-answer-wins
   door a thread's own card does. A question (a form or a URL) is answered in
   its thread, where its fields are drawn — the card only opens it. */
import * as React from "react"
import { ArrowUpRightIcon } from "lucide-react"

import type * as acp from "@daedalus/acp"
import { ErrorNote } from "@/components/error-note"
import { Group, StatusBadge } from "@/components/settings/primitives"
import { KindGlyph } from "@/components/notifications/items"
import { Button } from "@/components/ui/button"
import { captureError, inlineFromQuery } from "@/lib/errors"
import { useAnswerPending, usePending, type PendingItem } from "@/lib/queries/pending"
import { useProjects } from "@/lib/queries/catalog"
import { navigateTo, threadPath } from "@/lib/router"
import { ApiError } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

type Options = acp.RequestPermissionRequest["options"]

/** The narrow yes over the standing one, and the same for no — the same
    preference the thread's own card gives its primary button. */
const pick = (options: Options, prefix: "allow" | "reject") =>
  options.find((o) => o.kind === `${prefix}_once`) ?? options.find((o) => o.kind.startsWith(prefix))

function summary(item: PendingItem): string {
  if (item.kind === "permission") return item.request.toolCall?.title ?? "Permission requested"
  return item.request.message
}

export function NeedsYou() {
  const query = usePending()
  const items = query.data ?? []
  const loadError = React.useMemo(
    () => inlineFromQuery(query.error, "Could not read what the agents are waiting on"),
    [query.error]
  )
  if (!items.length && !loadError) return null
  return (
    <Group label="Needs you" action={<StatusBadge tone="warn" dot={false}>{items.length}</StatusBadge>}>
      {loadError && (
        <div className="py-3">
          <ErrorNote error={loadError} onRetry={() => void query.refetch()} />
        </div>
      )}
      {items.length > 0 && (
        <ul className="-mx-3 divide-y @panel-sm:-mx-4">
          {items.map((item) => (
            <li key={`${item.sessionId}:${item.requestId}`}>
              <PendingCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </Group>
  )
}

function PendingCard({ item }: { item: PendingItem }) {
  const answer = useAnswerPending()
  const projects = useProjects()
  const project = projects.find((p) => p.id === item.projectId)?.name
  const allow = item.kind === "permission" ? pick(item.request.options, "allow") : undefined
  const deny = item.kind === "permission" ? pick(item.request.options, "reject") : undefined
  /* A lost race is not a failure: somebody answered first and the row is
     leaving on the invalidation that follows. */
  const lost = answer.error instanceof ApiError && answer.error.status === 409
  const error = React.useMemo(
    () => (answer.error && !lost ? captureError(answer.error, "Could not send the answer") : null),
    [answer.error, lost]
  )
  const open = () => navigateTo(threadPath(item.sessionId))
  const send = (optionId: string) =>
    answer.mutate({ sessionId: item.sessionId, requestId: item.requestId, optionId })

  return (
    <article className="flex min-h-12 items-start gap-3 p-3 @panel-sm:p-4">
      <KindGlyph
        kind={item.kind === "permission" ? "permission" : "question"}
        read={false}
        className="mt-0.5 size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.threadTitle}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {shortAge(item.askedAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-3 text-xs text-pretty break-words text-muted-foreground">
          {summary(item)}
        </p>
        {project && <p className="mt-1 truncate text-xs text-muted-foreground">{project}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2 [&_[data-slot=button]]:pointer-coarse:h-11">
          {allow && (
            <Button size="sm" disabled={answer.isPending} onClick={() => send(allow.optionId)}>
              {allow.kind === "allow_always" ? "Always allow" : "Allow"}
            </Button>
          )}
          {deny && (
            <Button size="sm" variant="outline" disabled={answer.isPending} onClick={() => send(deny.optionId)}>
              Deny
            </Button>
          )}
          <Button
            size="sm"
            variant={allow || deny ? "ghost" : "outline"}
            className={cn(allow || deny ? "text-muted-foreground" : undefined)}
            onClick={open}
          >
            {item.kind === "elicitation" ? "Answer" : "Open"}
            <ArrowUpRightIcon data-icon="inline-end" />
          </Button>
        </div>
        {error && (
          <div className="mt-2">
            <ErrorNote error={error} />
          </div>
        )}
      </div>
    </article>
  )
}
