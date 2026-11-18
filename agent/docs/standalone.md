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
| `DAEDALUS_AGENT_SMALL_MODEL` | Model used for compaction summaries and thread titles. | the main model |
| `DAEDALUS_AGENT_TITLES` | Name a thread from its first message. `0`/`false` keeps the first line. | on |
| `DAEDALUS_AGENT_EFFORT` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` — the AI SDK's unified reasoning level. | provider default |
| `DAEDALUS_AGENT_CONTEXT_WINDOW` | Token window of the model spawned on, used for the usage readout and the compaction threshold. Reported as an estimate when unset — see `DAEDALUS_AGENT_MODEL_WINDOWS`. | 200000 (flagged estimated) |
| `DAEDALUS_AGENT_MAX_OUTPUT_TOKENS` | Per-response cap. Also the room reserved out of the compaction threshold, so a prompt never grows into the space the answer needs. | provider default |
| `DAEDALUS_AGENT_MODEL_WINDOWS` | `{"model-id":[contextWindow,maxOutputTokens]}` for every model reachable without a respawn. The model is a live setting, so the two figures above describe only the model the process *started* on; the map is what makes the readout and the threshold follow a switch. Unparseable or absent falls back to them. | none |
| `DAEDALUS_AGENT_PERSONA_FILE` | Path to a markdown file appended to the system prompt — see [prompting.md](./prompting.md). | none |
| `DAEDALUS_AGENT_MODEL_PROMPTS_FILE` | Path to a JSON file mapping model ids to instruction text (`{version: 1, entries: [{match, prompt}]}`), re-read every turn — see [prompting.md](./prompting.md). The harness writes this from its library; standalone, hand-write or script it. | none (built-in family calibrations stand alone) |
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
import * as acp from "@agentclientprotocol/sdk/unstable" // 2.7.0; the entry that types `subagents`, `subagent_update`, `systemPrompt`, `session/archive`

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

**What the agent claims back**, in its `initialize` answer, and what each buys
you as a client:

| It advertises | Which means |
| --- | --- |
| `sessionCapabilities.systemPrompt: { mode: { override: {} } }` | a request may carry ACP's `systemPrompt {mode, content}` on `session/new`, `load`, `resume` and `fork`: `append` lands as the persona layer (byte-identical to AIR `customInstructions`, which it outranks), `override` replaces the core instructions and model guidance and keeps tool guidance, plan mode and the workspace files; an unadvertised mode or a non-text block is `-32602` |
| `sessionCapabilities.archive: {}` | `session/archive` (closes a live session first, then flags it in `index.json`; the log is untouched, an archived session still `load`s and keeps talking) and `session/unarchive`; `session/list` takes `archived: "exclude" \| "include" \| "only"` (`exclude` by default, anything else `-32602`) and says `archived` on every row |
| `sessionCapabilities.list`, `.resume`, `.fork` | the store below; `session/fork` copies the store and returns the new id without opening a live session |
| `subagents: {}` (echoed) | children arrive as the RFD's one upsert, `subagent_update` on the parent's session — spawn as `{title, description, state: {state: "running"}, cwd, _meta.daedalus}`, an ending as `{state: "idle", stopReason: "end_turn" \| "error" \| "cancelled"}` (a failed one with `error {code, message}`), a `send_message` resume restating the spawn on the same id — plus the agent's own `_daedalus/subagent_usage`, which is where the usage is (never `state.usage`, so a client that sums both counts once) |

**Unknown session ids are `-32002`** (`RequestError.sessionNotFound`, `data.sessionId`)
from `session/prompt`, `load`, `resume`, `fork`, `delete`, `archive` and
`unarchive`; a bad fork point in a session that exists stays `-32602`. The SDK's
typed client resolves a `-32002` on `session/close`/`delete` as success
(`treatSessionNotFoundAsSuccess`), so over the SDK a delete of nothing is quiet.
A request's cancellation (`$/cancel_request`, or the connection dropping) is
chained into the turn through the same door `session/cancel` uses, so a held or
paused turn clears exactly as a cancel would.

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
never read from a config file — stdio (`{name, command, args, env}`) and the two
remote transports, streamable HTTP and SSE (`{type: "http" | "sse", name, url,
headers}`; the agent advertises `mcpCapabilities: { http, sse }` so a client
knows both are speakable). Their tools arrive as `mcp__<server>__<tool>`. A
server that fails to start is reported to the model in the system prompt rather
than killing the session.

**Deferred MCP tools** (`src/tools/tool-search.ts`): every MCP tool is marked
`deferLoading`, however few there are, and the AI SDK's `toolSearch()` is added as `search_tools`. The
SDK leaves deferred tools out of the request until a search finds them, then
sends each match from the next step on. Two things sit on top of the SDK's
version. Its discoveries last one `streamText` call, so a tool the conversation
already loaded (a search result or a call in the history) is built undeferred.
That is read off the messages, never stored: a reload keeps it, and a compaction
defers it again.

And it works like Claude Code's `ToolSearch` — the model already knows the names,
and the search is how it loads a schema. The description carries the catalogue:
every MCP tool, grouped under its server with a per-server count and a one-line
summary (all of them, so the list does not change when one loads, which is what
keeps the prefix cache). `select:` is the method and keywords are the fallback:

- `select:mcp__github__create_issue`, `<server>/<tool>`, `<server>/*`, a bare
  server name, or a bare tool name when exactly one tool carries it. Punctuation
  and case are forgiven. A selection of named tools is never cut short — the SDK's
  cap is set to the catalogue's own size.
- `+gh issue` searches one server; the name may be abbreviated (`gh` for
  `github`, a prefix or a subsequence, and only when it is unambiguous). `+gh`
  alone loads that server, up to 25 tools.
- Keywords rank name over description, one inflection deep (`issue` finds
  `list_issues`), and a query one suffix away from a name falls back to a
  name-substring match rather than coming back empty. A description-only word
  never rescues a miss: that is how a search loads strangers.

Loading a tool changes the tool block, so that one step re-sends the prompt
uncached.

What the agent's MCP client does with each server (`src/mcp.ts`,
`src/mcp-hooks.ts`, tested by `test/mcp-features.test.ts`):

- **Tools** — text, `structuredContent` (when the blocks say nothing),
  `resource_link` and embedded resources are read as text. **Images and audio**
  are named in the tool result and attached to the *next* model step as a user
  message, because an OpenAI-compatible tool message carries text only; a model
  whose catalog entry lists modalities without `image` is not sent them.
  Progress notifications show on the tool's row and restart its timeout; a
  cancelled turn cancels the call.
- **Prompts** are slash commands, `/<server>:<prompt>`.
- **Resources** are three tools per server: `list_resources`,
  `list_resource_templates` and `read_resource` (any URI, including a filled
  template).
- **Instructions** from the initialize answer go into the system prompt.
- **`list_changed`** replaces that server's tools or prompts in place; a new
  tool is offered from the next attempt, a new prompt is re-announced at once.
- **Requests from the server**, answered only while a turn runs: elicitation is
  forwarded as ACP `elicitation/create` (form, and url where the client claims
  it); sampling runs on the session's model behind a permission ask (`mcp` group,
  tool name `mcp__<server>__sampling`); roots is the session's cwd. Server log
  lines (warning and up) go to stderr.
- **Not done**: resource subscriptions (a turn-based agent has nobody to tell),
  tool use inside a sampling request.

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
`cursor`/`nextCursor`, optional `cwd` filter, `archived` filter — archived rows
are left out unless asked for) — which is also exactly what the harness's
**Import threads** dialog reads, so work done standalone in Zed can be imported
into the harness later, and vice versa. The archive flag lives on the index row
alone (`IndexEntry.archived`, no record in the session's JSONL), written
merge-on-write so two processes over one home do not clobber each other's rows;
a corrupt index loses archive flags with the listing, as it loses titles today.
The store is one directory: back it up by copying it, reset it by deleting it.
