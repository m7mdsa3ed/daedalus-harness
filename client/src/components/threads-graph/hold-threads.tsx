/* Holds a connection to each thread the graph is drawing workers for, so a
   thread no tab has open still brings its transcript — and with it the
   subagents and workflows only a transcript knows about. One component per
   thread because a hook cannot be called in a loop; it renders nothing. */
import { useThreadConnection } from "@/lib/thread/use-thread-connection"

function HoldThread({ sessionId }: { sessionId: string }) {
  useThreadConnection(sessionId)
  return null
}

export function HoldThreads({ ids }: { ids: string[] }) {
  return ids.map((id) => <HoldThread key={id} sessionId={id} />)
}
