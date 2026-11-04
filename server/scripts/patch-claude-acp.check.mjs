/* The resume the patch exists for, run against an adapter's native-subagents.js:
     node scripts/patch-claude-acp.check.mjs <adapter>/dist/native-subagents.js
   A child restored by a load, resumed under a SendMessage id, must receive the
   frames tagged with its launch id and be ended by a later SendMessage's id. */
import assert from "node:assert";
const { NativeSubagentRuntime } = await import(process.argv[2]);
const LAUNCH = "toolu_launch", SEND1 = "toolu_send1", SEND2 = "toolu_send2", AGENT = "a8795ea";
// What the patched replay seeds: the pre-restart child, finished, under its launch id.
const session = { nativeSubagentsByTaskId: new Map([[AGENT, { sessionId: "root:replay-subagent:" + LAUNCH, parentSessionId: "root", parentToolUseId: LAUNCH, name: "frontend", task: "t", announced: true, terminalState: "disconnected" }]]) };
const published = [];
// 0.100: the first argument is the form ("air" | "rfd" | undefined = off), not an enabled flag.
// "air" is the form this harness is on (CLIENT_CAPABILITIES declares _meta.jetbrains.air).
const rt = new NativeSubagentRuntime("air", "root", session, async (n) => published.push(n), { log() {}, error() {} });
const deliver = async (n) => published.push(n);
// The SDK's resume: task_started under the SendMessage id.
await rt.taskStarted({ taskId: AGENT, toolUseId: SEND1, subagentType: "general-purpose", description: "Frontend" }, deliver);
const spawned = published.find((n) => n.update.sessionUpdate === "subagent_spawned");
assert.ok(spawned, "the resumed generation is announced");
// The child's own frame, tagged with its launch id.
const frame = { sessionId: "root", update: { sessionUpdate: "tool_call", toolCallId: "t1", _meta: { claudeCode: { parentToolUseId: LAUNCH } } } };
const routed = await rt.route(frame, deliver);
assert.equal(routed?.sessionId, spawned.update.subagentSessionId, "a launch-id frame reaches the resumed child");
// Its end, notified under a later SendMessage id.
await rt.finishTask(AGENT, "completed", deliver, SEND2);
const end = published.find((n) => n.update.sessionUpdate === "subagent_state_update");
assert.deepEqual([end?.update.subagentSessionId, end?.update.state], [spawned.update.subagentSessionId, "completed"], "the end is matched");
console.log("resume check: ok", spawned.update.subagentSessionId);
