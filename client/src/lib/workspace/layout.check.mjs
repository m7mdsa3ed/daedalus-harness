/* The one runnable check behind `pruneLayout`: a layout saved by the build
   that had the dock-in-a-tab (`group` panels) comes back with each group tab
   replaced by the tabs it held — in its place, as one tab group — and a tab
   group or a bottom panel loses exactly the tabs that did not parse.

     ../server/node_modules/.bin/tsx src/lib/workspace/layout.check.mjs   (from client/)
*/
import assert from "node:assert"

import { pruneLayout } from "./layout.ts"

const chat = (sessionId) => ({
  id: `thread:${sessionId}`,
  contentComponent: "chat",
  params: { kind: "chat", sessionId },
  title: sessionId,
})
const leaf = (id, views, extra = {}) => ({
  type: "leaf",
  data: { id, views, activeView: views[0], ...extra },
})
const grid = (...leaves) => ({
  root: { type: "branch", data: leaves },
  width: 800,
  height: 600,
  orientation: "HORIZONTAL",
})

// ── An old group tab is unpacked in place, as a tab group ──
const legacy = {
  grid: grid(leaf("1", ["thread:a", "group:g", "thread:d"], { activeView: "group:g" })),
  panels: {
    "thread:a": chat("a"),
    "thread:d": chat("d"),
    "group:g": {
      id: "group:g",
      contentComponent: "group",
      params: {
        kind: "group",
        groupId: "g",
        layout: {
          grid: grid(leaf("1", ["thread:b"]), leaf("2", ["thread:c", "nonsense"])),
          panels: {
            "thread:b": chat("b"),
            "thread:c": chat("c"),
            nonsense: { id: "nonsense", contentComponent: "nope", params: {} },
          },
        },
      },
    },
  },
}

const out = pruneLayout(legacy)
assert.ok(out, "the layout survives")
const main = out.grid.root.data[0].data
assert.deepStrictEqual(main.views, ["thread:a", "thread:b", "thread:c", "thread:d"])
assert.strictEqual(main.activeView, "thread:b", "the group was in front, so its first tab is")
assert.deepStrictEqual(main.tabGroups.map((group) => group.panelIds), [["thread:b", "thread:c"]])
assert.ok(!("group:g" in out.panels) && "thread:c" in out.panels)

// ── A tab group and the bottom panel keep only what parsed ──
const current = {
  grid: grid(
    leaf("1", ["thread:a", "thread:x"], {
      tabGroups: [
        { id: "tg1", label: "Work", collapsed: false, panelIds: ["thread:a", "thread:x"] },
        { id: "tg2", collapsed: false, panelIds: ["thread:x"] },
      ],
    })
  ),
  panels: {
    "thread:a": chat("a"),
    "thread:x": { id: "thread:x", contentComponent: "chat", params: {} },
    "thread:e": chat("e"),
  },
  edgeGroups: {
    bottom: { size: 200, visible: true, group: { id: "9", views: ["thread:e"], activeView: "thread:e" } },
    left: { size: 200, visible: true, group: { id: "8", views: ["thread:x"] } },
  },
}

const pruned = pruneLayout(current)
assert.ok(pruned)
const only = pruned.grid.root.data[0].data
assert.deepStrictEqual(only.views, ["thread:a"])
assert.deepStrictEqual(only.tabGroups, [{ id: "tg1", label: "Work", collapsed: false, panelIds: ["thread:a"] }])
assert.deepStrictEqual(Object.keys(pruned.edgeGroups ?? {}), ["bottom"], "an edge group left empty is dropped")

console.log("layout.check: ok")

// ── A tab filed under another space is owed to it once, then taken ──
{
  const { stashPanels, takeStashedPanels } = await import("./layout.ts")
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    get length() { return store.size },
    key: (i) => [...store.keys()][i] ?? null,
  }
  const a = { kind: "chat", sessionId: "a" }
  stashPanels("srv", "work", [a])
  stashPanels("srv", "work", [a, { kind: "terminal", projectId: "p", terminalId: "t" }]) // merged, no duplicate
  stashPanels("srv", "", [a]) // no space, nothing filed
  assert.deepStrictEqual(takeStashedPanels("srv", "work").map((p) => p.kind), ["chat", "terminal"])
  assert.deepStrictEqual(takeStashedPanels("srv", "work"), []) // taken once
}
