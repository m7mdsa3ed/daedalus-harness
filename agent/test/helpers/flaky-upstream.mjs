/**
 * A throwaway OpenAI-compatible upstream for exercising **held turns** by hand.
 * Manual only — nothing imports it, `pnpm test` does not run it.
 *
 *   node agent/test/helpers/flaky-upstream.mjs        # listens on 4599
 *
 * It serves two model ids so one profile catalog can hold both, which is what
 * makes the switch live (`applyConfigLive` needs the agent to already offer the
 * id it is being moved to):
 *
 *   flaky-429   first request runs a tool, every one after it is a 429
 *   good-model  streams a short answer
 *
 * So the sequence a held turn is built for falls out of it: the tool runs, the
 * next model step is rate limited, the turn holds with the finished tool call
 * intact, you switch to `good-model` and press Continue — and the tool is not
 * run again. Watch this process's stdout to see which model each step asked for.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FLAKY_PORT ?? 4599);
let flakyCalls = 0;

const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};
const frame = (delta, finish = null) => ({
  id: "chatcmpl-stub",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1e3),
  model: "stub",
  choices: [{ index: 0, delta, finish_reason: finish }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
});

createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "flaky-429" }, { id: "good-model" }] }));
    }
    const model = (() => {
      try {
        return JSON.parse(body).model;
      } catch {
        return "";
      }
    })();

    if (model === "flaky-429") {
      flakyCalls += 1;
      if (flakyCalls === 1) {
        console.log(`→ ${model} (step 1: one tool call)`);
        return sse(res, [
          frame({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: '{"command":"echo held-turn-test"}' },
              },
            ],
          }),
          frame({}, "tool_calls"),
        ]);
      }
      console.log(`→ ${model} (call ${flakyCalls}: 429)`);
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      return res.end(
        JSON.stringify({
          error: { message: "rate limit exceeded on flaky-429", type: "rate_limit_error" },
        }),
      );
    }

    console.log(`→ ${model} (answering)`);
    return sse(res, [
      frame({ role: "assistant", content: "Continued on the model you switched to." }),
      frame({}, "stop"),
    ]);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`flaky upstream on http://127.0.0.1:${PORT}/v1`));
