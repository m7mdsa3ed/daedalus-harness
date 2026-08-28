// Self-check for the harness's own `web-search` MCP server, which is
// profile-driven (a profile opts in) and synthesized from config at spawn — it
// is never a stored library row. The pieces worth proving:
//   - toMcpServerEnv maps a WebSearchConfig onto the four stdio env vars.
//   - websearchServer() returns null when no search API is configured, and the
//     synthesized stdio def (node + path to the MCP server file + live env)
//     when it is — never touching a library row.
//   - the profile gate: web-search is OFF by default (unset / disabled), and ON
//     for claude-code when the profile opts in AND search is configured.
// Run: pnpm test:websearch
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.DAEDALUS_DATA_DIR!;
// A stale config.json from a previous run would flip the "unconfigured"
// assertion, so start clean the way workspace-fs.test.ts does.
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });

const { resolveWebSearch, websearchServer } = await import("../src/sessions.js");
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

type ProfileWs = { enabled: boolean; searchApiBaseUrl?: string; searchApiToken?: string; searchModel?: string; fetchModel?: string };
const profile = (ws?: ProfileWs) => ({ webSearch: ws ?? null });

await test("not enabled -> null even when server config present", async () => {
  writeConfig({
    searchApiBaseUrl: "http://localhost:20128",
    searchApiToken: "live-token",
    searchModel: "search-combo",
    fetchModel: "fetch-combo",
  });
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  assert.equal(websearchServer(profile(), cfg), null, "enabled defaults off");
  assert.ok(websearchServer(profile({ enabled: true }), cfg), "enabled + config synthesizes");
});

await test("unconfigured -> null even when enabled", async () => {
  writeConfig();
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  assert.equal(websearchServer(profile({ enabled: true }), cfg), null);
});

await test("profile override beats server default", async () => {
  writeConfig({
    searchApiBaseUrl: "http://server:20128",
    searchApiToken: "server-token",
    searchModel: "server-search",
    fetchModel: "server-fetch",
  });
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  const server = websearchServer(
    profile({ enabled: true, searchApiBaseUrl: "http://profile:9000", searchModel: "profile-search" }),
    cfg,
  );
  assert.ok(server, "synthesized");
  assert.deepEqual(server.env, toMcpServerEnv({
    searchApiBaseUrl: "http://profile:9000",
    searchApiToken: "server-token", // inherits
    searchModel: "profile-search", // overrides
    fetchModel: "server-fetch", // inherits
  }));
  assert.ok(!mcpServers.list().some((s) => s.name === WEB_SEARCH_SERVER_NAME), "no library row");
});

await test("no override -> server default + live env", async () => {
  writeConfig({
    searchApiBaseUrl: "http://server:20128",
    searchApiToken: "server-token",
    searchModel: "server-search",
    fetchModel: "server-fetch",
  });
  const cfg = await import("../src/config.js").then((m) => m.loadConfig());
  const server = websearchServer(profile({ enabled: true }), cfg);
  assert.ok(server, "synthesized");
  assert.equal(server.name, WEB_SEARCH_SERVER_NAME);
  assert.equal(server.command, process.execPath);
  assert.ok((server.args as string[]).length === 1 && (server.args as string[])[0].endsWith("websearch-mcp.js"));
  assert.deepEqual(server.env, toMcpServerEnv(cfg.webSearch!));
});

await test("profile gate: default profile is off", async () => {
  const { defaultProfileFor } = await import("../src/profiles.js");
  const d = defaultProfileFor("claude-code");
  assert.equal(d.webSearch?.enabled, false, "default profile opts out");
});

if (failures.length) {
  console.error("websearch.test.ts FAILED\n" + failures.join("\n\n"));
  process.exit(1);
}
console.log(`websearch: ${passed} passed`);
