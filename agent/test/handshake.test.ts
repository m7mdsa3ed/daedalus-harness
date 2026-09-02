import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import * as acp from "../src/acp.js";
import { buildAgentApp } from "../src/app.js";
import { FULL_CAPS, initialize, makeClient, testEnv } from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));

// --- in-process: handshake, session/new, config options, modes ---
{
  const env = testEnv();
  const agent = buildAgentApp({ env });
  const { app: client, harness } = makeClient();

  await client.connectWith(agent, async (ctx) => {
    const init = await initialize(ctx);
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.list, "advertises session/list");
    assert.equal(init.agentCapabilities?.promptCapabilities?.embeddedContext, true);

    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    assert.ok(created.sessionId);
    assert.equal(created.modes?.currentModeId, "default");
    assert.deepEqual(
      created.modes?.availableModes.map((m) => m.id),
      ["default", "acceptEdits", "bypassPermissions", "plan"],
    );

    const options = created.configOptions ?? [];
    const model = options.find((o) => o.id === "model");
    assert.equal(model?.category, "model");
    assert.equal(model?.currentValue, "test-model");
    const effort = options.find((o) => o.id === "effort");
    assert.equal(effort?.category, "thought_level");
    const autoCompact = options.find((o) => o.id === "autoCompact");
    assert.equal(autoCompact?.type, "boolean");
    assert.equal(autoCompact?.currentValue, true);

    // Effort moves; the answer is the whole (absolute) option list.
    const set = await ctx.request("session/set_config_option", {
      sessionId: created.sessionId,
      configId: "effort",
      value: "high",
    });
    assert.equal(set.configOptions.find((o) => o.id === "effort")?.currentValue, "high");
    assert.ok(harness.updatesOf("config_option_update").length >= 1);

    // A model the allowlist does not offer is refused, not silently taken.
    await assert.rejects(
      ctx.request("session/set_config_option", {
        sessionId: created.sessionId,
        configId: "model",
        value: "not-a-model",
      }),
    );

    await ctx.request("session/set_mode", { sessionId: created.sessionId, modeId: "plan" });
    const modeUpdates = harness.updatesOf("current_mode_update");
    assert.equal(
      (modeUpdates.at(-1)?.update as { currentModeId?: string }).currentModeId,
      "plan",
    );

    // Boolean config option only exists when the client claims the capability.
    const bare = buildAgentApp({ env: testEnv() });
    void bare; // capability gating is checked through a second client below
  });

  // A client that claims no boolean capability gets no boolean option.
  const { app: plainClient } = makeClient();
  const agent2 = buildAgentApp({ env: testEnv() });
  await plainClient.connectWith(agent2, async (ctx) => {
    await initialize(ctx, { ...FULL_CAPS, session: { compaction: {} } });
    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    assert.equal(created.configOptions?.find((o) => o.type === "boolean"), undefined);
  });
  console.log("handshake: in-process ok");
}

// --- binary: the real process over ndJSON stdio ---
{
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DAEDALUS_AGENT_MODEL: "test-model",
      DAEDALUS_AGENT_HOME: mkdtempSync(join(tmpdir(), "daedalus-agent-home-")),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (msg: unknown) => void>();
  lines.on("line", (line) => {
    const msg = JSON.parse(line) as { id?: number; result?: unknown };
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id) as (m: unknown) => void;
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  let nextId = 0;
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve as (msg: unknown) => void);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const init = (await request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: FULL_CAPS,
  })) as { result: acp.InitializeResponse };
  assert.equal(init.result.agentCapabilities?.loadSession, true);

  const created = (await request("session/new", { cwd, mcpServers: [] })) as {
    result: acp.NewSessionResponse;
  };
  assert.ok(created.result.sessionId);
  child.kill();
  console.log("handshake: binary ok");
}

console.log("handshake.test.ts passed");
