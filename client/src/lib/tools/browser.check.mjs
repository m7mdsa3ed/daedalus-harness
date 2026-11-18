/* The runnable check behind the browser-tools reader: every dialect's name for
   a call into the `browser` server comes out as one call, another server's
   `snapshot` does not, the answer's page line and snapshot are read, an
   `act`'s element is named from the snapshot that issued its uid, and the
   row's heading and summary say what happened to the page.

     pnpm exec tsx --tsconfig tsconfig.app.json src/lib/tools/browser.check.mjs   (from client/)
*/
import assert from "node:assert"

import {
  browserElementName,
  browserHeading,
  browserSummary,
  extractBrowserCall,
} from "./browser.ts"
import { toolHeading } from "./heading.ts"
import { toolSummary, toolViewOf } from "./view.ts"

const PAGE = [
  "click done",
  "tab t2: https://example.com/account — Account",
  "",
  '[4_1] RootWebArea "Account"',
  '  [4_2] heading "Welcome" level=1',
  '  [4_3] button "Sign out"',
].join("\n")

const envelope = (text, image) => ({
  content: [...(image ? [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] : []), { type: "text", text }],
})

const tool = (name, rawInput, rawOutput, extra = {}) => ({
  kind: "tool",
  id: extra.id ?? name,
  title: name,
  status: "completed",
  rawInput,
  rawOutput,
  content: [],
  locations: [],
  ...extra,
})

// Claude Code / our runtime: flattened name; the server is checked.
const act = tool("mcp__browser__act", { action: "click", uid: "3_7" }, envelope(PAGE), { id: "act-1" })
const call = extractBrowserCall(act)
assert.equal(call.tool, "act")
assert.deepEqual(call.page, { tabId: "t2", url: "https://example.com/account", title: "Account" })
assert.equal(call.head, "click done")
assert.equal(call.snapshot.length, 3)
assert.equal(toolViewOf(act), "browser")
assert.equal(toolSummary(act, false), "example.com/account")
assert.deepEqual(browserHeading(call), { title: "Click", detail: "[3_7]" })

// Codex: the pair kept apart.
const codex = tool(
  "mcp.browser.navigate",
  { server: "browser", tool: "navigate", arguments: { url: "https://example.com" } },
  { result: envelope("status 200\ntab t2: https://example.com/ — Example Domain") }
)
assert.equal(extractBrowserCall(codex).tool, "navigate")
// Not a web fetch, even though it carries an http url.
assert.equal(toolViewOf(codex), "browser")
assert.equal(toolHeading(codex).title, "Open")
assert.equal(toolHeading(codex).detail, "example.com")

// Another server's `snapshot` is not ours.
assert.equal(extractBrowserCall(tool("mcp__figma__snapshot", {}, envelope("x"))), null)
assert.equal(extractBrowserCall(tool("mcp__browser__unknown", {}, envelope("x"))), null)

// A screenshot carries its image, in the envelope or as an ACP block.
const shot = tool("mcp__browser__screenshot", {}, envelope("screenshot of tab t2 (https://example.com/)", true))
assert.deepEqual(extractBrowserCall(shot).image, { data: "AAAA", mimeType: "image/jpeg" })
const shotBlock = tool("mcp__browser__screenshot", {}, undefined, {
  content: [{ type: "content", content: { type: "image", data: "BBBB", mimeType: "image/jpeg" } }],
})
assert.equal(extractBrowserCall(shotBlock).image.data, "BBBB")
assert.equal(toolSummary(shot, false), "image")

// The element an act names comes from the earlier snapshot that issued it.
const snap = tool(
  "mcp__browser__snapshot",
  {},
  envelope('tab t2: https://example.com/ — Home\n\n[3_1] RootWebArea "Home"\n  [3_7] link "Account \\"me\\""'),
  { id: "snap-1" }
)
assert.equal(browserElementName([snap, act], "act-1", "3_7"), 'link "Account "me""')
// Never from the act's own answer (the page after it), and not from a later step.
assert.equal(browserElementName([act, snap], "act-1", "3_7"), null)
assert.equal(browserSummary(extractBrowserCall(snap)), "2 nodes")

// A failed call says so.
const failed = tool("mcp__browser__wait_for", { text: "Done" }, { content: [{ type: "text", text: "not seen after 5000ms" }], isError: true })
assert.equal(extractBrowserCall(failed).failed, true)
assert.equal(browserSummary(extractBrowserCall(failed)), "error")

console.log("browser tools: ok")
