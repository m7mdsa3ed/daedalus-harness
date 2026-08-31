/* ── Automations ── the one tier for everything that happens without you.
   Two kinds under one heading, and the labels are the feature:

     Routines    start a NEW thread, from nothing, on a clock / a webhook /
                 a commit — and answer the agent's questions themselves.
     Scheduled   speak into a thread that ALREADY EXISTS, once or on a period.

   They were separate ideas that arrived a release apart and would have ended up
   as two sibling tiers reading as two unrelated features, which is the same
   mistake as a nav row that works instead of navigating: someone looking for
   "the thing that runs while I'm asleep" has to already know which of the two
   words we chose for it. One tier, two halves, each half saying in its own rows
   what it does to a thread — because "routine" and "scheduled message" are not
   words that tell themselves apart. */
import { Sparkles } from "lucide-react"
import type { Actions } from "@/lib/actions"
import { useStore } from "@/lib/store"
import { FoldableGroup } from "./groups"
import { RoutinesGroup } from "./routines"
import { ScheduledGroup } from "./scheduled"

/** Routines above scheduled messages: a routine is the bigger commitment (it
    spawns an agent and may answer for you), so it leads, and the count on the
    outer label is both halves — the number you are asking about here is "how
    much is armed", not "how many of which kind". */
export function AutomationsGroup({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const armed = state.routines.length + state.scheduled.length

  return (
    <FoldableGroup
      groupKey="__automations"
      label="Automations"
      icon={<Sparkles className="size-3 shrink-0" />}
      count={armed > 0 ? armed : undefined}
    >
      <RoutinesGroup actions={actions} />
      <ScheduledGroup actions={actions} />
    </FoldableGroup>
  )
}
