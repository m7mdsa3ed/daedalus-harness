# Daedalus Harness — Mid-Thread Agent Handoff (Claude ↔ Codex ↔ OpenCode ↔ Daedalus ↔ ACP)

## Context & Problem

Today in Daedalus, a thread/session is bound to a specific agent (`sessions.agent_id`) and its underlying ACP runtime session (`sessions.acp_session_id`).

In ACP (Agent Client Protocol):
1. **Siloed Agent Storage**: Each agent binary (Claude Code, Codex ACP, OpenCode, Daedalus Agent) manages its own session store in `~/.claude`, `~/.codex`, `~/.opencode`, or `~/.daedalus-agent`.
2. **Incompatible Session IDs**: Reviving or resuming an agent relies on `session/load(acp_session_id)`. Codex cannot load Claude's session ID, OpenCode cannot load Codex's session ID, and vice versa.
3. **User Need**: Users frequently want to switch agents in the middle of a complex task (e.g., using Claude for architecture exploration, switching to Codex for deep multi-file repo edits, or handing off to OpenCode / custom ACP agents for specific tool suites).

## Core Insights & Feasibility

- **Daedalus Owns the Journal**: Unlike dumb ACP clients, Daedalus stores all events in `session_events` (SQLite). The unified conversation transcript, tool invocations, file changes, and turns already live in Daedalus independent of any single agent runtime.
- **Handoff via Synthetic Context Seeding**:
  When transitioning a thread from Agent A to Agent B:
  1. Retire/stop Agent A's live process.
  2. Synthesize a concise, structured Handoff Context Summary (plus active goals/tasks and recent file modifications) from `session_events`.
  3. Spawn Agent B via `session/new` pointing to the same workspace (`cwd`).
  4. Inject the handoff transcript into Agent B as initial context (via system prompt `_meta` extension or a synthetic bootstrap turn).
  5. Retain the continuous visual transcript in Daedalus UI while updating the active agent binding.

---

## Architectural Design

### 1. The Handoff Lifecycle

```
[User triggers Switch to Agent B]
            │
            ▼
[SessionManager: switchAgent(sessionId, newAgentId)]
            │
            ├─ 1. Halt/Retire active Agent A bridge
            ├─ 2. Compile Handoff Context from `session_events`
            ├─ 3. Update `sessions.agent_id` = newAgentId in SQLite
            ├─ 4. Spawn Agent B (`session/new`), obtain new `acp_session_id`
            ├─ 5. Store synthetic `agent_handoff` milestone event in journal
            └─ 6. Broadcast `agent_switched` event to client peers
```

### 2. Context Synthesis (`server/src/handoff.ts`)

Extract key signals from `session_events`:
- **Thread Objective / Summary**: User intent across past turns.
- **Modified Files**: List of touched files and diff summaries from tool calls (`edit`, `apply_patch`, `write_file`).
- **Current Task / Plan State**: Todos or plan milestones.
- **Recent Turns**: The last $N$ turns in markdown format.

The compiled handoff payload is formatted as:
```markdown
# Context Handoff from previous agent (claude -> codex)

## Objective & Current Progress
...

## Modified Files
- `src/server.ts`
- `src/routes/sessions.ts`

## Conversation Summary
User: ...
Assistant: ...
```

### 3. Protocol & Journal Changes

1. **Protocol Event (`protocol.ts`)**:
   - Add `agent_switched` notification event:
     ```ts
     export interface AgentSwitchedEvent {
       event: "agent_switched";
       sessionId: string;
       previousAgentId: string;
       newAgentId: string;
       agentName: string;
     }
     ```
2. **Wire Command**:
   - `switch_agent`: `{ cmd: "switch_agent", agentId: string, customInstruction?: string }`
3. **Journal Milestone**:
   - A distinct transcript item rendered in the UI (e.g., a divider badge: *"Switched agent to Codex"*).

---

## Implementation Steps

### Phase 1: Server Engine & Context Compiler
- Create `server/src/handoff.ts` to format conversation events into a clean markdown transcript digest.
- Add `SessionManager.switchAgent(sessionId, newAgentId, instructions?)`:
  - Gracefully stops current agent bridge.
  - Updates DB record (`sessions.agent_id`, clearing old `acp_session_id`).
  - Spawns new agent with `session/new` and seeds context.
  - Records the transition in `session_events`.

### Phase 2: API & Protocol Endpoints
- Add REST route: `POST /api/sessions/:id/switch-agent` with `{ agentId, instruction? }`.
- Add WebSocket command handler `switch_agent` in `server/src/session-socket.ts`.

### Phase 3: Client UI & Switching Experience
- In `client/src/components/thread-view.tsx` / header / composer settings:
  - Add an Agent Selector dropdown allowing switching the agent on an active thread.
  - Add optional modal: "Handoff to [Agent] — Include summary & current workspace state".
  - Render an `AgentSwitched` milestone marker in the transcript.

### Phase 4: Verification & Edge Cases
- Test switching between `daedalus` ↔ `fake-echo` ↔ `claude` ↔ `codex` ↔ `opencode`.
- Verify behavior when switching while a turn is active (must reject or cancel before switching).
- Verify permission mode and live config synchronization for the new agent.

---

## Risks & Mitigations

- **Context Window Blowup**: Naive replay of 100 turns could fill the new agent's context window.
  - *Mitigation*: Truncate older turns, retain latest 5 turns verbatim and summarize previous turns.
- **Tool Discrepancies**: Different agents use different tool signatures (`apply_patch` vs `edit_file`).
  - *Mitigation*: The handoff provides standard markdown descriptions of file changes rather than raw agent-specific tool payloads.
