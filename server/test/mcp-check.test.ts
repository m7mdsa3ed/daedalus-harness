// Self-check for the harness's own MCP client: the listing carries
// instructions, capabilities and templates; a call runs on one pooled
// connection; a child's stderr rides the error. Uses the agent's full fixture
// server.
// Run: pnpm test:mcp-check
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMcpServer, invokeMcp } from "../src/mcp-check.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../agent/test/helpers/mcp-full-server.mjs");
const def = { name: "full", command: process.execPath, args: [FIXTURE], env: [] };

const listed = await checkMcpServer(def);
assert.equal(listed.ok, true, listed.error ?? "");
assert.equal(listed.instructions, "Call pic before describing anything.");
assert.ok(listed.capabilities?.completions, "capabilities are passed through");
assert.deepEqual(listed.resourceTemplates?.map((t) => t.uri), ["mem://{key}"]);
console.log("mcp-check: listing ok");

/* A filled template is an ordinary resource read. */
const read = await invokeMcp("full", def, { kind: "resource", name: "mem://zz" });
assert.equal(read.ok, true, read.error ?? "");
assert.match(JSON.stringify(read.result), /contents of mem:\/\/zz/);
const prompt = await invokeMcp("full", def, { kind: "prompt", name: "greet", args: { who: "ada" } });
assert.match(JSON.stringify(prompt.result), /hello ada/);
console.log("mcp-check: pooled invoke ok");

/* A child that dies before the handshake says why, not just "closed". */
const broken = await checkMcpServer({
  name: "broken",
  command: process.execPath,
  args: ["-e", "console.error('missing API_KEY'); process.exit(1)"],
  env: [],
});
assert.equal(broken.ok, false);
assert.match(broken.error ?? "", /missing API_KEY/);
console.log("mcp-check: stderr tail ok");
process.exit(0); // the pool keeps its child until idle; the test does not wait
