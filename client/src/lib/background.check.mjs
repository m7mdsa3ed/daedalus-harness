/* The two readings a thread with background work says, as one runnable check:
   the foot of the transcript names the run (`statusFor`), and `backgroundOf`
   prefers the server's answer over a journal that still holds a dead run's last
   `running` — which is the whole reason the field exists.

     ../server/node_modules/.bin/tsx src/lib/background.check.mjs   (from client/)
*/
import assert from "node:assert"

import { emptyThread } from "./store/thread.ts"
import { statusFor } from "./thread/status.ts"
import { backgroundOf } from "./thread/statuses.ts"

const session = (extra = {}) => ({ id: "s", backgroundActive: false, ...extra })

// A live thread whose agent still has a run going: the transcript says so.
{
  const thread = {
    ...emptyThread,
    phase: { kind: "live" },
    background: true,
    items: [
      {
        kind: "async-task",
        id: "async-task:wt-1",
        taskId: "wt-1",
        name: "fake-audit-live",
        taskType: "workflow",
        description: "Audit the repo",
        state: "running",
        progress: [
          { type: "workflow_agent", index: 1, label: "read:server", state: "progress" },
        ],
        startedAt: 1,
      },
    ],
  }
  const status = statusFor(thread)
  assert.equal(status?.kind, "background", "the foot of the transcript names the run")
  assert.match(status.headline, /running$/)
  assert.equal(status.tone, "progress")
  assert.equal(backgroundOf(session(), thread), true)

  // Turn gone, no run: nothing said, and no reading claims busy.
  const idle = { ...thread, background: false }
  assert.equal(statusFor(idle), null, "an idle thread keeps its silence")
  assert.equal(backgroundOf(session(), idle), false)
}

// No socket on this device: the row is the only word, and it wins over a
// journal that still holds the dead run's last `running`.
{
  const thread = {
    ...emptyThread,
    phase: { kind: "archived" },
    items: [{ kind: "async-task", id: "a", taskId: "a", name: "n", taskType: "workflow", description: "", state: "running", progress: [], startedAt: 1 }],
  }
  assert.equal(backgroundOf(session({ backgroundActive: false }), thread), false, "the server's answer outranks a stale journal")
  assert.equal(backgroundOf(session({ backgroundActive: true }), thread), true, "…including when it says a run is going")
  assert.equal(backgroundOf(session({ backgroundActive: true }), undefined), true, "a thread never opened still reads busy")
}

// A server that predates the field: the transcript, as before.
{
  const thread = { ...emptyThread, phase: { kind: "live" }, items: [{ kind: "async-task", id: "a", taskId: "a", name: "n", taskType: "workflow", description: "", state: "running", progress: [], startedAt: 1 }] }
  assert.equal(backgroundOf(session({ backgroundActive: undefined }), thread), true)
  assert.equal(backgroundOf(session({ backgroundActive: undefined }), undefined), false)
}

console.log("background check OK")
