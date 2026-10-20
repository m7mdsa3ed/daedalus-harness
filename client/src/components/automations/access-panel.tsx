/* ── The Access tab ──
   What this automation may do without asking, as a list you can take back from.
   The full per-kind editor is the Settings tab's Access section; this is the
   reading — "Always allowed", revocable one row at a time — because the
   question asked of a standing grant is "what exactly did I give it", and a
   table of selects answers it worse than a short list does. A `session`
   automation has no policy of its own: it is a message into a thread, and the
   thread's permissions apply. */
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"

import { Notice } from "@/components/notice"
import { Group, Row, Section, StatusBadge } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { reportError } from "@/lib/errors"
import { useUpdateAutomation } from "@/lib/queries/automations"
import type { Routine } from "@/lib/settings"
import { toast } from "@/lib/toast"
import { KINDS } from "./autonomy-control"

export function AccessPanel({ routine, onEdit }: { routine: Routine; onEdit: () => void }) {
  const update = useUpdateAutomation()

  if (routine.runsIn === "session")
    return (
      <Notice tone="info">
        This automation delivers its prompt into a thread, so that thread&rsquo;s own permissions apply. Change them
        from the thread; there is nothing to grant here.
      </Notice>
    )

  const { permissions } = routine.autonomy
  const allowed = KINDS.filter((k) => permissions[k.kind] === "allow")
  const denied = KINDS.filter((k) => permissions[k.kind] === "deny")
  const blanket = permissions.default === "allow"

  const revoke = (kind: string) =>
    update.mutate(
      { id: routine.id, patch: { autonomy: { ...routine.autonomy, permissions: { ...permissions, [kind]: "ask" } } } },
      {
        onSuccess: () => toast.success("Access revoked — it will ask again"),
        onError: (err) => reportError(err, "Couldn't revoke access"),
      }
    )

  return (
    <>
      {blanket && (
        <Section>
          <Notice tone="warn" title="Full access">
            Anything the agent asks for that has no narrower answer below is allowed with nobody watching, in the
            project&rsquo;s working directory.
          </Notice>
        </Section>
      )}
      <Group
        label="Always allowed"
        hint="Answered yes without asking a person. Revoking puts the question back to a human."
        action={
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit all access
          </Button>
        }
      >
        {allowed.length === 0 && !blanket ? (
          <Row icon={ShieldCheckIcon} title="Nothing" subtitle="Every question waits for a person." />
        ) : (
          <>
            {allowed.map((k) => (
              <Row key={k.kind} icon={ShieldAlertIcon} title={k.label} subtitle={k.blurb}>
                {k.grave && <StatusBadge tone="warn" dot={false}>Powerful</StatusBadge>}
                <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => revoke(k.kind)}>
                  Revoke
                </Button>
              </Row>
            ))}
            {blanket && (
              <Row icon={ShieldAlertIcon} title="Everything else" subtitle="The blanket answer for any tool not listed.">
                <StatusBadge tone="warn" dot={false}>Blanket allow</StatusBadge>
                <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => revoke("default")}>
                  Revoke
                </Button>
              </Row>
            )}
          </>
        )}
      </Group>
      {denied.length > 0 && (
        <Group label="Never allowed" hint="Refused outright.">
          {denied.map((k) => (
            <Row key={k.kind} title={k.label} subtitle={k.blurb} />
          ))}
        </Group>
      )}
      <Group label="Limits">
        <Row title="Unanswered questions">
          <span className="text-sm">
            {routine.autonomy.askTimeoutSeconds > 0
              ? `${routine.autonomy.askFallback === "deny" ? "Denied" : "Cancelled"} after ${Math.round(routine.autonomy.askTimeoutSeconds / 60)} min`
              : "Wait forever"}
          </span>
        </Row>
        <Row title="Ceiling">
          <span className="text-sm">
            {routine.autonomy.maxRunSeconds > 0 ? `${Math.round(routine.autonomy.maxRunSeconds / 60)} min` : "none"}
            {routine.autonomy.maxRunTokens ? ` · ${routine.autonomy.maxRunTokens.toLocaleString()} tokens` : ""}
          </span>
        </Row>
      </Group>
    </>
  )
}
