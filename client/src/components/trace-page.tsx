/* ── The trajectory page ── /t/<sessionId>/trace
   A thread's spans as a full page — the same `Trajectory` the thread dock's
   panel draws, given the page's height and the header's overlap. */
import { useParams } from "react-router"

import { Trajectory } from "@/components/trajectory/trajectory"

export function TracePage() {
  const { sessionId = "" } = useParams()
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Trajectory sessionId={sessionId} variant="page" />
    </div>
  )
}
