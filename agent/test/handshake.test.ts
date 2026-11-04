import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import * as acp from "../src/acp.js";
import { buildAgentApp } from "../src/app.js";
import {
  connectPair,
  FULL_CAPS,
  initialize,
  makeClient,
  promptOf,
  scriptedModel,
  testEnv,
  textScript,
} from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));

// --- in-process: handshake, session/new, config options, modes ---
{
  const env = testEnv();
  const agent = buildAgentApp({ env });
  const { app: client, harness } = makeClient();

  await connectPair(agent, client, async (ctx) => {
    const init = await initialize(ctx);
    assert.equal(init.agentCapabilities?.loadSession, true);
    assert.ok(init.agentCapabilities?.sessionCapabilities?.list, "advertises session/list");
    assert.ok(init.agentCapabilities?.sessionCapabilities?.close, "advertises session/close");
    assert.ok(init.agentCapabilities?.sessionCapabilities?.delete, "advertises session/delete");
    assert.equal(init.agentCapabilities?.mcpCapabilities?.http, true, "advertises http MCP");
    assert.equal(init.agentCapabilities?.mcpCapabilities?.sse, true, "advertises sse MCP");
    assert.equal(init.agentCapabilities?.promptCapabilities?.embeddedContext, true);
    /* The two v1.29 doors, as the schema spells them: `systemPrompt` with
       `mode.override` (a bare `{}` would be append-only), and `archive`. */
    assert.deepEqual(
      init.agentCapabilities?.sessionCapabilities?.systemPrompt,
      { mode: { override: {} } },
      "advertises systemPrompt in append and override modes",
    );
    assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.archive, {}, "advertises session/archive");

    /* An unknown session id is the protocol's own -32002, naming the id, on
       every door that takes one — never a generic invalid-params. (`session/
       delete` answers the same on the wire, but the SDK's client resolves a
       -32002 on close/delete as success — `treatSessionNotFoundAsSuccess` — so
       its wire shape is asserted over raw NDJSON in the binary section below.) */
    for (const [method, params] of [
      ["session/prompt", { sessionId: "no-such-session", prompt: promptOf("hi") }],
      ["session/load", { sessionId: "no-such-session", cwd, mcpServers: [] }],
      ["session/fork", { sessionId: "no-such-session", cwd }],
      ["session/archive", { sessionId: "no-such-session" }],
      ["session/unarchive", { sessionId: "no-such-session" }],
    ] as const) {
      await assert.rejects(ctx.request(method, params as never), (err: unknown) => {
        const e = err as { code?: number; data?: { sessionId?: string } };
        assert.equal(e.code, -32002, `${method} on an unknown id is -32002`);
        assert.equal(e.data?.sessionId, "no-such-session", `${method} names the id in data.sessionId`);
        return true;
      });
    }

    /* A `systemPrompt` this runtime cannot apply is an error instead of a
       session — the spec forbids reading an unknown mode as `append`, and a
       block kind a system prompt cannot hold is the same refusal. */
    for (const systemPrompt of [
      { mode: "_vendor/whisper", content: [{ type: "text", text: "x" }] },
      { mode: "append", content: [{ type: "image", data: "", mimeType: "image/png" }] },
    ]) {
      await assert.rejects(
        ctx.request("session/new", { cwd, mcpServers: [], systemPrompt } as never),
        (err: unknown) => {
          assert.equal((err as { code?: number }).code, -32602, "an unsupported systemPrompt is invalid params");
          return true;
        },
      );
    }
    const listedUnknown = ctx.request("session/list", { archived: "_vendor/soon" } as never);
    await assert.rejects(listedUnknown, (err: unknown) => {
      assert.equal((err as { code?: number }).code, -32602, "an unknown archived filter is -32602");
      return true;
    });

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
  await connectPair(agent2, plainClient, async (ctx) => {
    await initialize(ctx, { ...FULL_CAPS, session: { compaction: {} } });
    const created = await ctx.request("session/new", { cwd, mcpServers: [] });
    assert.equal(created.configOptions?.find((o) => o.type === "boolean"), undefined);
  });
  console.log("handshake: in-process ok");
}

// --- the capability literal round-trips the SDK's own initialize parser ---
{
  /* app.ts registers `initialize` on the SDK's parser (the plain `.onRequest`
     overload), so the whole literal the harness sends has to come out the other
     side — `subagents` and `plan` (the RFD opt-ins) and `_meta` included. An
     agent built on the same overload records exactly what that parser hands a
     handler; the daedalus agent's own read of the result is what
     subagents.test.ts ("RFD negotiated") exercises. */
  let seen: unknown = "never called";
  const probe = acp
    .agent({ name: "caps-probe" })
    .onRequest("initialize", ({ params }) => {
      seen = params.clientCapabilities;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
      } satisfies acp.InitializeResponse;
    });
  const { app: client } = makeClient();
  await connectPair(probe, client, async (ctx) => {
    await initialize(ctx);
  });
  /* The parser fills the spec's defaults (`terminal: false`, `auth`) beside
     what was sent; what matters is that nothing sent was stripped. */
  const parsed = seen as Record<string, unknown>;
  for (const [key, value] of Object.entries(FULL_CAPS)) {
    assert.deepEqual(parsed[key], value, `clientCapabilities.${key} survives the SDK's initialize parser`);
  }
  assert.ok("subagents" in parsed && "plan" in parsed && "_meta" in parsed);
  console.log("handshake: capability literal round-trips ok");
}

// --- session/close parks the thread here but keeps it; session/delete erases it ---
{
  const env = testEnv();
  const agent = buildAgentApp({ env, makeModel: scriptedModel([textScript("Hello there, world. ")]) });
  const { app: client } = makeClient();
  await connectPair(agent, client, async (ctx) => {
    await initialize(ctx);
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    await ctx.request("session/prompt", { sessionId, prompt: promptOf("hi") });

    // Close: the session stops being live in this process, and the log stays.
    await ctx.request("session/close", { sessionId });
    await assert.rejects(
      ctx.request("session/prompt", { sessionId, prompt: promptOf("again") }),
      "a closed session does not answer prompts",
    );
    // …and it can be brought back into this same process.
    const loaded = await ctx.request("session/load", { sessionId, cwd, mcpServers: [] });
    assert.ok(loaded.modes, "a closed session still loads from its log");
    // A second close is teardown of nothing, not a failure.
    await ctx.request("session/close", { sessionId });

    // Delete: the log and its listing are gone, and it cannot come back.
    await ctx.request("session/delete", { sessionId });
    const listed = (await ctx.request("session/list", { cwd })) as { sessions: { sessionId: string }[] };
    assert.ok(!listed.sessions.some((s) => s.sessionId === sessionId), "the listing no longer shows it");
    /* The agent answers -32002 for a second delete (the wire shape is pinned in
       the binary section); the SDK's client treats that as the idempotent
       success the protocol lets a close/delete be, so this resolves. */
    await ctx.request("session/delete", { sessionId });
    await assert.rejects(ctx.request("session/load", { sessionId, cwd, mcpServers: [] }));
  });
  console.log("handshake: close and delete ok");
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

  // On the wire, a request for a session this agent never held is -32002 with data.sessionId.
  const missing = (await request("session/delete", { sessionId: "no-such-session" })) as {
    error?: { code: number; data?: { sessionId?: string } };
  };
  assert.equal(missing.error?.code, -32002, "session/delete of an unknown id is -32002 on the wire");
  assert.equal(missing.error?.data?.sessionId, "no-such-session");
  const missingPrompt = (await request("session/prompt", {
    sessionId: "no-such-session",
    prompt: [{ type: "text", text: "hi" }],
  })) as { error?: { code: number; data?: { sessionId?: string } } };
  assert.equal(missingPrompt.error?.code, -32002, "session/prompt of an unknown id is -32002 on the wire");
  assert.equal(missingPrompt.error?.data?.sessionId, "no-such-session");
  child.kill();
  console.log("handshake: binary ok");
}

console.log("handshake.test.ts passed");
