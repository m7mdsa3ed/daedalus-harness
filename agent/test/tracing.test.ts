import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentApp, TRACE_CAPABILITY, TRACE_NOTIFICATION } from "../src/app.js";
import type { TraceNotification } from "../src/tracing.js";
import { connectPair, initialize, makeClient, promptOf, scriptedModel, testEnv, textScript, toolCallScript } from "./helpers/scripted.js";

const cwd = mkdtempSync(join(tmpdir(), "daedalus-agent-cwd-"));
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const HARNESS_SPAN = "00f067aa0ba902b7";

// --- a turn's spans come up over ACP, tagged to the session, under the harness's span ---
{
  const agent = buildAgentApp({
    env: testEnv(),
    makeModel: scriptedModel([
      toolCallScript("task", { description: "look", prompt: "find it" }, { input: 20, output: 8 }),
      textScript("child report ", { input: 10, output: 5 }),
      textScript("Done. ", { input: 10, output: 5 }),
    ]),
  });
  const { app } = makeClient();
  const traces: TraceNotification[] = [];
  const client = app.onNotification(
    TRACE_NOTIFICATION,
    (p: unknown) => p as TraceNotification,
    ({ params }) => {
      traces.push(params);
    },
  );
  await connectPair(agent, client, async (ctx) => {
    const init = await initialize(ctx);
    assert.equal(init.agentCapabilities?._meta?.[TRACE_CAPABILITY], true, "the capability is advertised");
    const { sessionId } = await ctx.request("session/new", { cwd, mcpServers: [] });
    const response = await ctx.request("session/prompt", {
      sessionId,
      prompt: promptOf("delegate"),
      _meta: { traceparent: `00-${TRACE_ID}-${HARNESS_SPAN}-01` },
    });
    assert.equal(response.stopReason, "end_turn");

    /* Flushed before the answer, so nothing to wait for. */
    const spans = traces.filter((t) => t.sessionId === sessionId).flatMap((t) => t.spans);
    assert.ok(spans.length > 0, "spans arrived before the turn answered");
    for (const s of spans) {
      assert.equal(s.traceId, TRACE_ID, `${s.name} is in the harness's trace`);
      assert.equal(s.attributes["daedalus.acp_session_id"], sessionId, `${s.name} is tagged to the session`);
    }
    const turn = spans.find((s) => s.name === "agent turn");
    assert.ok(turn, "the turn span");
    assert.equal(turn.parentSpanId, HARNESS_SPAN, "the turn is parented under the traceparent");
    assert.equal(turn.attributes["daedalus.kind"], "turn");

    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const roots = spans.filter((s) => s.attributes["gen_ai.operation.name"] === "invoke_agent");
    const parentRun = roots.find((s) => s.attributes["gen_ai.agent.name"] === "daedalus.turn");
    const childRun = roots.find((s) => s.attributes["gen_ai.agent.name"] === "daedalus.subagent");
    assert.ok(parentRun && childRun, `both runs traced (got ${spans.map((s) => s.name).join(", ")})`);
    assert.equal(parentRun.parentSpanId, turn.spanId, "the SDK's run nests under the turn");
    /* The subagent runs inside the `task` tool's execution, so its run is
       that tool span's child. */
    const taskSpan = byId.get(childRun.parentSpanId ?? "");
    assert.equal(taskSpan?.name, "execute_tool task", "the subagent nests under its task call");
    assert.ok(spans.some((s) => s.name.startsWith("chat ") && typeof s.attributes["gen_ai.input.messages"] === "string"));
  });
}

console.log("tracing: ok");
process.exit(0);
