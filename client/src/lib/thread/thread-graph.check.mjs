/* The `/graph` builder: the tree, run folding, transcript workers, the merge,
   the batch fold, forks, a missing parent and the Active scope.

     ../server/node_modules/.bin/tsx src/lib/thread/thread-graph.check.mjs   (from client/)
*/
import assert from "node:assert"

import { BATCH_FOLD, threadGraph } from "./thread-graph.ts"

const session = (id, extra = {}) => ({ id, projectId: "p1", title: id, cursor: 1, deletedAt: null, ...extra })
const agent = (sessionId, extra = {}) => ({
  kind: "subagent",
  id: `subagent:${sessionId}`,
  sessionId,
  name: "worker",
  task: `do ${sessionId}`,
  state: "running",
  capabilities: {},
  startedAt: 0,
  ...extra,
})
const graph = (sessions, states, { threads = {}, scope = "active" } = {}) =>
  threadGraph({
    sessions,
    threads,
    states: new Map(Object.entries(states)),
    projects: [{ id: "p1", name: "Harness" }],
    scope,
  })
const ids = (g) => g.nodes.map((n) => n.id).sort()
const edge = (g, from, to) => g.edges.find((e) => e.from === from && e.to === to)

// The tree: project → thread → ask; a step joins through its run node.
{
  const g = graph(
    [
      session("a"),
      session("ask", { parentSessionId: "a", childKind: "ask" }),
      session("s1", { parentSessionId: "a", childKind: "workflow", childRunId: "r1", childRunName: "review" }),
      session("s2", { parentSessionId: "a", childKind: "workflow", childRunId: "r1", childRunName: "review" }),
    ],
    { a: "running", ask: "waiting", s1: "running", s2: "running" }
  )
  assert.deepEqual(ids(g), ["p:p1", "t:a", "t:ask", "t:s1", "t:s2", "workflow:r1"])
  assert.ok(edge(g, "p:p1", "t:a"))
  assert.equal(edge(g, "t:a", "t:ask").label, "ask")
  assert.equal(edge(g, "t:a", "workflow:r1").label, "workflow")
  assert.ok(edge(g, "workflow:r1", "t:s1") && edge(g, "workflow:r1", "t:s2"))
  assert.equal(g.nodes.find((n) => n.id === "t:ask").hint, "ask · waiting on you")
  assert.equal(g.nodes.find((n) => n.id === "t:s1").open, "s1")
}

// Active scope: idle threads drop out, but an active child keeps its idle parent.
{
  const sessions = [session("idle"), session("parent"), session("child", { parentSessionId: "parent", childKind: "ask" })]
  const g = graph(sessions, { idle: "idle", parent: "idle", child: "running" })
  assert.deepEqual(ids(g), ["p:p1", "t:child", "t:parent"])
  assert.equal(g.nodes.find((n) => n.id === "t:parent").tone, "pending")
  // All shows idle threads too, never archived ones.
  const all = graph([...sessions, session("old")], { idle: "idle", parent: "idle", child: "running", old: "archived" }, { scope: "all" })
  assert.ok(ids(all).includes("t:idle") && !ids(all).includes("t:old"))
}

// Drafts, trash and a parent that is gone.
{
  const g = graph(
    [session("draft", { draft: true }), session("bin", { deletedAt: 1 }), session("orphan", { parentSessionId: "gone", childKind: "ask" })],
    { draft: "running", bin: "running", orphan: "running" }
  )
  assert.deepEqual(ids(g), ["p:p1", "t:orphan"])
  assert.ok(edge(g, "p:p1", "t:orphan"))
}

// A fork hangs off what it was forked from, dashed.
{
  const g = graph([session("a"), session("f", { forkedFromSessionId: "a" })], { a: "running", f: "running" })
  assert.deepEqual(edge(g, "t:a", "t:f"), { from: "t:a", to: "t:f", label: "fork", dashed: true })
  assert.ok(!edge(g, "p:p1", "t:f"))
}

// Native subagents nest from the transcript; a finished one is not drawn.
{
  const items = [agent("x"), agent("y", { parentId: "subagent:x" }), agent("done", { state: "completed" })]
  const g = graph([session("a")], { a: "running" }, { threads: { a: { items, turnActive: true, background: false } } })
  assert.ok(edge(g, "t:a", "sa:subagent:x"))
  assert.ok(edge(g, "sa:subagent:x", "sa:subagent:y"))
  assert.ok(!ids(g).includes("sa:subagent:done"))
  assert.equal(g.nodes.find((n) => n.id === "sa:subagent:y").open, "a")
}

// The merge: a head naming a listed session is that session's node, not a second one.
{
  const items = [agent("ask")]
  const g = graph(
    [session("a"), session("ask", { parentSessionId: "a", childKind: "ask" })],
    { a: "running", ask: "running" },
    { threads: { a: { items, turnActive: true, background: false } } }
  )
  assert.deepEqual(ids(g), ["p:p1", "t:a", "t:ask"])
}

// A harness run from the transcript is the same run node the list makes, with pending steps from its plan.
{
  const wf = (step) => ({ runId: "r1", name: "review", step, plan: [{ name: null, steps: ["lint", "tests", "docs"] }] })
  const items = [agent("s1", { workflow: wf("lint") }), agent("s2", { workflow: wf("tests"), state: "completed" })]
  const g = graph(
    [session("a"), session("s1", { parentSessionId: "a", childKind: "workflow", childRunId: "r1", childRunName: "review" })],
    { a: "running", s1: "running" },
    { threads: { a: { items, turnActive: true, background: false } } }
  )
  assert.equal(g.nodes.filter((n) => n.id === "workflow:r1").length, 1)
  assert.ok(edge(g, "workflow:r1", "t:s1"))
  assert.ok(edge(g, "workflow:r1", "sa:subagent:s2"), "a finished step of a live run is still drawn")
  assert.equal(g.nodes.find((n) => n.id === "sa:subagent:s2").tone, "done")
  assert.ok(ids(g).includes("pending:workflow:r1:0:2"), "the unspawned step")
  assert.ok(!ids(g).includes("pending:workflow:r1:0:0"))
}

// A wide batch folds into one count.
{
  const items = Array.from({ length: BATCH_FOLD + 2 }, (_, i) => agent(`b${i}`))
  const g = graph([session("a")], { a: "running" }, { threads: { a: { items, turnActive: true, background: false } } })
  const more = g.nodes.find((n) => n.id.startsWith("more:"))
  assert.equal(more.label, `${BATCH_FOLD + 2} agents`)
  assert.ok(!ids(g).some((id) => id.startsWith("sa:")))
}

// A placed worker says where, against its thread's project; outside it, the whole path.
{
  const items = [agent("in", { cwd: "/repo/src/api/" }), agent("out", { cwd: "/tmp/scratch" }), agent("root", { cwd: "/repo" })]
  const g = threadGraph({
    sessions: [session("a")],
    threads: { a: { items, turnActive: true, background: false } },
    states: new Map([["a", "running"]]),
    projects: [{ id: "p1", name: "Harness", cwd: "/repo" }],
    scope: "active",
  })
  assert.equal(g.nodes.find((n) => n.id === "sa:subagent:in").hint, "worker · in src/api · running")
  assert.equal(g.nodes.find((n) => n.id === "sa:subagent:out").hint, "worker · in /tmp/scratch · running")
  assert.equal(g.nodes.find((n) => n.id === "sa:subagent:root").hint, "worker · in . · running")
  const bare = graph([session("a")], { a: "running" }, { threads: { a: { items: [agent("x")], turnActive: true, background: false } } })
  assert.equal(bare.nodes.find((n) => n.id === "sa:subagent:x").hint, "worker · running", "no cwd, no place")
}

// Every node says its kind; a run opens the thread that started it.
{
  const g = graph(
    [session("a"), session("s1", { parentSessionId: "a", childKind: "workflow", childRunId: "r1", childRunName: "review" })],
    { a: "running", s1: "running" }
  )
  const kind = (id) => g.nodes.find((n) => n.id === id).kind
  assert.equal(kind("p:p1"), "project")
  assert.equal(g.nodes.find((n) => n.id === "p:p1").projectId, "p1")
  assert.equal(kind("t:a"), "thread")
  assert.equal(kind("workflow:r1"), "run")
  assert.equal(g.nodes.find((n) => n.id === "workflow:r1").open, "a")
}

// Needs you: waiting, held and failed threads, with the chain above them; running alone is not.
{
  const sessions = [
    session("run"),
    session("wait"),
    session("fail"),
    session("parent"),
    session("child", { parentSessionId: "parent", childKind: "ask" }),
  ]
  const g = graph(sessions, { run: "running", wait: "waiting", fail: "failed", parent: "running", child: "held" }, { scope: "needs-you" })
  assert.deepEqual(ids(g), ["p:p1", "t:child", "t:fail", "t:parent", "t:wait"])
}

// Project and title filters narrow any scope and keep the chain above a match.
{
  const sessions = [
    session("a", { title: "Fix login" }),
    session("b", { title: "Docs pass", projectId: "p2" }),
    session("c", { title: "Ask · review LOGIN", parentSessionId: "d", childKind: "ask" }),
    session("d", { title: "Refactor" }),
  ]
  const states = { a: "running", b: "running", c: "running", d: "running" }
  const filter = (extra) =>
    threadGraph({
      sessions,
      threads: {},
      states: new Map(Object.entries(states)),
      projects: [{ id: "p1", name: "Harness" }, { id: "p2", name: "Docs" }],
      scope: "active",
      ...extra,
    })
  assert.deepEqual(ids(filter({ projectId: "p2" })), ["p:p2", "t:b"])
  assert.deepEqual(ids(filter({ query: " login " })), ["p:p1", "t:a", "t:c", "t:d"])
  assert.deepEqual(ids(filter({ query: "login", projectId: "p2" })), [])
}

console.log("thread-graph.check: ok")
