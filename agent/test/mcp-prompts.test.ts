import assert from "node:assert/strict";
import type { CommandDef } from "../src/commands.js";
import { expandCommand } from "../src/commands.js";
import { promptArgs, toolKey } from "../src/mcp.js";

/* The whole of the free-text-line → named-arguments guess. */
const one = [{ name: "query", required: true }];
assert.deepEqual(promptArgs(one, "how do refunds work"), { query: "how do refunds work" });
assert.deepEqual(promptArgs(one, ""), {});

const two = [
  { name: "repo", required: true },
  { name: "since" },
];
assert.deepEqual(promptArgs(two, "since=yesterday daedalus-harness"), {
  since: "yesterday",
  repo: "daedalus-harness",
});
/* An `=` in a value is not a second key, and an unknown key is prose. */
assert.deepEqual(promptArgs(one, "a=b c=d"), { query: "a=b c=d" });
assert.deepEqual(promptArgs([{ name: "url" }], "url=http://x/?a=1"), { url: "http://x/?a=1" });

/* A fetched command asks the server; a file command still expands its body. */
const commands: CommandDef[] = [
  { name: "local", description: "", body: "body $ARGUMENTS" },
  {
    name: "srv:ask",
    description: "",
    body: "(placeholder)",
    fetch: async (args) => `fetched<${args}>`,
  },
  {
    name: "srv:broken",
    description: "",
    body: "(placeholder)",
    fetch: async () => {
      throw new Error("nope");
    },
  },
];

assert.equal(await expandCommand(commands, "/local x"), "body x");
assert.equal(await expandCommand(commands, "/srv:ask hello there"), "fetched<hello there>");
assert.equal(await expandCommand(commands, "/unknown"), null);
assert.equal(await expandCommand(commands, "not a command"), null);
/* A refused prompt is a degraded message, never a failed turn. */
assert.match((await expandCommand(commands, "/srv:broken")) ?? "", /placeholder[\s\S]*nope/);

/* A tool name a provider will accept: `^[a-zA-Z0-9_-]+$`, whatever the user
   called the server or the server called its tool. */
assert.equal(toolKey("HR System", "query-schema"), "mcp__HR_System__query-schema");
assert.equal(toolKey("web-search", "web_search"), "mcp__web-search__web_search");
for (const [server, tool] of [
  ["HR System", "query-schema"],
  ["a.b/c:d", "tool name"],
  ["Ünïcode", "tool"],
] as const) {
  assert.match(toolKey(server, tool), /^[a-zA-Z0-9_-]+$/, `${server}/${tool}`);
}

console.log("mcp-prompts ok");
