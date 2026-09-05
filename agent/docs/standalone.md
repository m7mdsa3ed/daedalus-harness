# Running Daedalus Agent without the harness

The agent is an ordinary **ACP agent binary**. It speaks the Agent Client
Protocol over ndJSON on stdin/stdout and knows nothing about the harness: the
harness is simply the ACP *client* that usually spawns it. Anything else that
speaks ACP can spawn it instead — Zed, another editor, a script of your own —
and everything below is what the harness normally does for you, done by hand.

Nothing in the agent reaches back into the harness: no HTTP calls, no database,
no shared files. Its only inputs are its env, the `cwd` a session names, and
the ACP messages it is sent.

## 1. Build it

```bash
cd agent
pnpm install
pnpm build          # → agent/dist/index.js
```

`dist/index.js` is the entry point. It writes only the protocol to stdout;
everything human — errors, stack traces, warnings — goes to stderr, so a client
can pipe stderr wherever it likes without corrupting the stream.

## 2. Configure it

Every setting is an environment variable. An unset or empty variable falls back;
the literal string `"null"` is also read as unset (that is what the harness's
unquoted-JSON placeholders resolve to, and the agent matches it so the same
template works either way).

| Variable | Meaning | Default |
| --- | --- | --- |
| `DAEDALUS_AGENT_MODEL` | Model id sent to the endpoint. **Required** — a turn with none fails with a clear error. | — |
| `DAEDALUS_AGENT_BASE_URL` | OpenAI-compatible base URL (the `/v1` root that serves `/chat/completions`). | `https://api.openai.com/v1` |
| `DAEDALUS_AGENT_API_KEY` | Sent as `Authorization: Bearer …`. | a placeholder, for gateways that want the header but ignore it |
| `DAEDALUS_AGENT_SMALL_MODEL` | Model used for compaction summaries. | the main model |
| `DAEDALUS_AGENT_EFFORT` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` — the AI SDK's unified reasoning level. | provider default |
| `DAEDALUS_AGENT_CONTEXT_WINDOW` | Token window, used for the usage readout and the compaction threshold. | 200000 |
| `DAEDALUS_AGENT_MAX_OUTPUT_TOKENS` | Per-response cap. | provider default |
| `DAEDALUS_AGENT_PERSONA_FILE` | Path to a markdown file appended to the system prompt — see [prompting.md](./prompting.md). | none |
| `DAEDALUS_AGENT_PROJECT_INSTRUCTIONS` | `0` to stop reading `AGENTS.md` / `CLAUDE.md` from the workspace. | on |
| `DAEDALUS_AGENT_PROMPT_CACHE_KEY` | `0` to stop sending `prompt_cache_key` (the session id) — the affinity hint that keeps a thread's steps on one backend, so its prefix cache stays warm. Turn it off only for an upstream that rejects unknown body fields. | on |
| `DAEDALUS_AGENT_HOME` | Where transcripts live. | `~/.daedalus-agent` |

**Only OpenAI-compatible endpoints.** There is no Anthropic-messages path and no
provider auto-detection; point `DAEDALUS_AGENT_BASE_URL` at anything that serves
`POST {base}/chat/completions` — OpenAI, a router, vLLM, Ollama's compatible
endpoint, your own gateway.

## 3. Spawn it from an editor

Zed's `settings.json` takes a custom ACP agent under `agent_servers`:

```json
{
  "agent_servers": {
    "Daedalus": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/daedalus-harness/agent/dist/index.js"],
      "env": {
        "DAEDALUS_AGENT_MODEL": "gpt-4o",
        "DAEDALUS_AGENT_BASE_URL": "https://api.openai.com/v1",
        "DAEDALUS_AGENT_API_KEY": "sk-…"
      }
    }
  }
}
```

Any other ACP client is the same three fields — a command, its args, and an env.

## 4. Or drive it yourself

With the ACP SDK, in process or over a spawned pipe:

```ts
import * as acp from "@agentclientprotocol/sdk"

await acp.client({ name: "my-client" })
  .onRequest("session/request_permission", ({ params }) => {
    console.log("asking:", params.toolCall.title)
    return { outcome: { outcome: "selected", optionId: "allow" } }
  })
  .onNotification("session/update", ({ params }) => console.log(params.update))
  .connectWith(stream, async (agent) => {
    await agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const { sessionId } = await agent.request("session/new", { cwd: process.cwd(), mcpServers: [] })
    const done = await agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "What is in this directory?" }],
    })
    console.log(done.stopReason)
  })
```

Or by hand, which is worth doing once to see the shape of it — one JSON object
per line, in and out:

```bash
cd agent
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"'"$PWD"'","mcpServers":[]}}'
  sleep 1
} | DAEDALUS_AGENT_MODEL=gpt-4o node dist/index.js
```

## 5. What you are now responsible for

These are the things the harness supplies that nothing else will.

**Capabilities decide features.** The agent withholds anything the client did
not claim in `initialize`, which is ACP's bargain and not a bug — a feature
offered to a client that cannot render it is a hang. Claim what you can handle:

| Claim | Buys you |
| --- | --- |
| `elicitation: { form: {} }` | the `ask_user` tool exists at all; without it the model cannot ask you a question |
| `session: { configOptions: { boolean: {} } }` | the `autoCompact` switch appears in `configOptions` |
| `session: { compaction: {} }` | compaction is announced as it happens (it still *runs* either way) |
| `subagents: {}` | the `task` tool reports as real child sessions instead of folding into one tool result |

**Permissions.** `session/request_permission` is a real request the agent blocks
on. Answer it, or set the session mode to `bypassPermissions` and never be
asked. The four modes are `default`, `acceptEdits`, `bypassPermissions` and
`plan` (read-only).

**The model list.** The `model` config option offers whatever is in
`<cwd>/.claude/settings.local.json` under `availableModels`, plus the spawned
model. The harness writes that file; standalone, write it yourself to get a
picker with more than one entry:

```json
{ "availableModels": ["gpt-4o", "gpt-4o-mini", "o3"] }
```

**MCP servers** are passed by the client in `session/new` (and `session/load`),
never read from a config file — stdio (`{name, command, args, env}`) and HTTP
(`{type: "http", name, url, headers}`). Their tools arrive as
`mcp__<server>__<tool>`. A server that fails to start is reported to the model
in the system prompt rather than killing the session.

**Project instructions are read from the session's `cwd` with no help from
anyone**: `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md`, from the cwd up to the
repo root, plus `~/.claude/CLAUDE.md` — so an editor that spawns this agent in a
repo gets that repo's house rules for free. [prompting.md](./prompting.md) has
the exact rules.

**Skills and commands** are read from the session's `cwd`:
`.claude/commands/*.md` become slash commands (advertised over
`available_commands_update`, expanded on `/name args`, `$ARGUMENTS`
substituted), and `.claude/skills/<name>/SKILL.md` are listed in the system
prompt for the model to read on demand. Both are plain files — create them by
hand and they work.

## 6. Where the conversations go

`$DAEDALUS_AGENT_HOME` (default `~/.daedalus-agent`):

```
~/.daedalus-agent/
  index.json              # one entry per session: id, cwd, title, updatedAt
  sessions/<uuid>.jsonl   # meta / msg (model history) / update (replay) / compact records
```

`session/load` replays a session's `update` records as live notifications and
then keeps talking with the `msg` history restored, so a client can reopen a
conversation across restarts. `session/list` pages that index (100 at a time,
`cursor`/`nextCursor`, optional `cwd` filter) — which is also exactly what the
harness's **Import threads** dialog reads, so work done standalone in Zed can be
imported into the harness later, and vice versa. The store is one directory:
back it up by copying it, reset it by deleting it.
