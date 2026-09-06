// Self-check for the harness's own `web-search` MCP server: linked through a
// `builtin` library row that stores nothing, and synthesized from config at
// spawn. The pieces worth proving:
//   - toMcpServerEnv maps a WebSearchConfig onto the four stdio env vars.
//   - websearchServer() returns null when no search API is configured, and the
//     synthesized stdio def (node + path to the MCP server file + live env)
//     when it is.
//   - the library gate: a thread gets the server only when a builtin row is
//     linked, and a linked row resolves to nothing while search is
//     unconfigured — a tool that cannot answer is not advertised.
//   - ensureBuiltin is idempotent: one fixed id, however often it is pressed.
// Run: pnpm test:websearch
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.DAEDALUS_DATA_DIR!;
// A stale config.json from a previous run would flip the "unconfigured"
// assertion, so start clean the way workspace-fs.test.ts does.
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const { websearchServer, mcpServersFor } = await import("../src/sessions.js");
const { mcpServers } = await import("../src/library.js");
const { toMcpServerEnv, SEARCH_ENV_KEYS, WEB_SEARCH_SERVER_NAME } = await import("../src/websearch.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function writeConfig(webSearch?: Record<string, string>) {
  writeFileSync(
    join(DATA, "config.json"),
    JSON.stringify({
      token: "x",
      host: "127.0.0.1",
      port: 8799,
      sessionIdleMinutes: 30,
      ...(webSearch ? { webSearch } : {}),
    }),
  );
}

await test("toMcpServerEnv maps a WebSearchConfig to the four env vars", () => {
  const pairs = toMcpServerEnv({
    searchApiBaseUrl: "http://localhost:20128",
    searchApiToken: "secret",
    searchModel: "search-combo",
    fetchModel: "fetch-combo",
  });
  assert.deepEqual(pairs.map((p) => p.name), [...SEARCH_ENV_KEYS]);
  assert.deepEqual(Object.fromEntries(pairs.map((p) => [p.name, p.value])), {
    WEB_SEARCH_API_BASE_URL: "http://localhost:20128",
    WEB_SEARCH_API_TOKEN: "secret",
    WEB_SEARCH_MODEL: "search-combo",
    WEB_FETCH_MODEL: "fetch-combo",
  });
});

await test("unconfigured -> null", async () => {
  writeConfig();
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  assert.equal(websearchServer(cfg), null);
});

await test("configured -> stdio def with live env", async () => {
  writeConfig({
    searchApiBaseUrl: "http://server:20128",
    searchApiToken: "server-token",
    searchModel: "server-search",
    fetchModel: "server-fetch",
  });
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  const server = websearchServer(cfg);
  assert.ok(server, "synthesized");
  assert.equal(server.name, WEB_SEARCH_SERVER_NAME);
  assert.equal(server.command, process.execPath);
  // Under tsx (how the tests run) the script is the .ts beside the module and
  // node is handed tsx's CLI to run it; built, it is the bare dist .js.
  const script = (server.args as string[]).at(-1)!;
  assert.match(script, /websearch-mcp\.(ts|js)$/);
  assert.ok(existsSync(script), `MCP server script exists: ${script}`);
  assert.deepEqual(server.env, toMcpServerEnv(cfg.webSearch!));
});

await test("ensureBuiltin is idempotent and the row stores nothing", () => {
  const first = mcpServers.ensureBuiltin("web-search");
  const second = mcpServers.ensureBuiltin("web-search");
  assert.equal(first.id, second.id);
  assert.equal(first.id, "builtin:web-search");
  assert.equal(mcpServers.list().filter((s) => s.type === "builtin").length, 1);
  assert.equal(first.type, "builtin");
  assert.ok(!("command" in first) && !("env" in first), "no command or env on the row");
});

await test("library gate: linked + configured -> server; linked + unconfigured -> nothing", async () => {
  const row = mcpServers.ensureBuiltin("web-search");
  const project = { id: "p1" };
  writeConfig({
    searchApiBaseUrl: "http://server:20128",
    searchApiToken: "server-token",
    searchModel: "server-search",
    fetchModel: "server-fetch",
  });
  let cfg = await import("../src/config.js").then((m) => m.loadConfig());
  assert.deepEqual(mcpServersFor({ mcpServerIds: [] }, project, cfg).servers, [], "not linked -> not offered");
  const { servers: linked } = mcpServersFor({ mcpServerIds: [row.id] }, project, cfg);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].name, WEB_SEARCH_SERVER_NAME);
  writeConfig();
  cfg = await import("../src/config.js").then((m) => m.loadConfig());
  assert.deepEqual(mcpServersFor({ mcpServerIds: [row.id] }, project, cfg).servers, [], "linked but unconfigured -> nothing");
});

await test("knowledge builtin resolves with the project's id in env", async () => {
  const row = mcpServers.ensureBuiltin("knowledge");
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  const [server] = mcpServersFor({ mcpServerIds: [row.id] }, { id: "proj-42" }, cfg).servers;
  assert.ok(server && "env" in server, "stdio def");
  assert.ok(server.env!.some((e) => e.name === "KNOWLEDGE_PROJECT_ID" && e.value === "proj-42"));
});

if (failures.length) {
  console.error("websearch.test.ts FAILED\n" + failures.join("\n\n"));
  process.exit(1);
}
console.log(`websearch: ${passed} passed`);
