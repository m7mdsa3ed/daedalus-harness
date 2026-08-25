import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { DATA_DIR, readJson, writeJson } from "./config.js";
import { getAgent, resolveSpawn } from "./registry.js";
import type { Profile } from "./profiles.js";
import type { Project } from "./projects.js";
import { materializeProject } from "./materialize.js";

/** One NDJSON frame with its direction: agent->client or client->agent. */
export interface JournalEntry {
  d: "a" | "c";
  line: string;
}

export interface Session {
  id: string;
  profileId: string;
  projectId: string;
  agentId: string;
  model: string;
  effort: string;
  title: string;
  acpSessionId?: string;
  createdAt: number;
  journal: JournalEntry[];
  /** null = no live process (loaded from disk / retired); revive via respawn. */
  proc: ChildProcessWithoutNullStreams | null;
  ws: WebSocket | null;
  detachedAt: number | null;
  exited: boolean;
  promptActive: boolean;
  pendingPrompts: Set<string | number>;
  pendingNews: Set<string | number>;
}

/** What survives a server restart. The conversation itself lives in the
    agent's own session store and comes back via ACP session/load on revive. */
type PersistedSession = Pick<
  Session,
  "id" | "profileId" | "projectId" | "agentId" | "model" | "effort" | "title" | "acpSessionId" | "createdAt"
>;

const SESSIONS_PATH = join(DATA_DIR, "sessions.json");

export interface SessionEvents {
  /** Fired only while no client is attached — used for push notifications. */
  onPermissionRequest?: (session: Session) => void;
  onTurnEnd?: (session: Session) => void;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private events: SessionEvents = {}, idleMinutes = 30) {
    // Sessions from before the last server restart: processes are gone, but the
    // thread identity remains and the client can revive it (respawn + load).
    for (const p of readJson<PersistedSession[]>(SESSIONS_PATH, [])) {
      this.sessions.set(p.id, {
        ...p,
        journal: [],
        proc: null,
        ws: null,
        detachedAt: Date.now(),
        exited: true,
        promptActive: false,
        pendingPrompts: new Set(),
        pendingNews: new Set(),
      });
    }

    const idleMs = idleMinutes * 60_000;
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.exited && !s.ws && s.detachedAt && Date.now() - s.detachedAt > idleMs) {
          this.retire(s);
        }
      }
    }, 60_000).unref();
  }

  private persist(): void {
    writeJson(
      SESSIONS_PATH,
      [...this.sessions.values()].map((s): PersistedSession => ({
        id: s.id,
        profileId: s.profileId,
        projectId: s.projectId,
        agentId: s.agentId,
        model: s.model,
        effort: s.effort,
        title: s.title,
        acpSessionId: s.acpSessionId,
        createdAt: s.createdAt,
      })),
    );
  }

  /** Stop the process but keep the thread — the opposite of kill(). */
  private retire(session: Session): void {
    const proc = session.proc;
    session.proc = null; // flips the generation guard
    session.exited = true;
    session.journal = [];
    session.promptActive = false;
    session.pendingPrompts.clear();
    session.pendingNews.clear();
    proc?.kill();
  }

  private spawnProc(profile: Profile, project: Project, model?: string, effort?: string) {
    const agent = getAgent(profile.agentId);
    if (!agent) throw new Error(`unknown agent: ${profile.agentId}`);
    materializeProject(project);
    const { command, args, env, cwd } = resolveSpawn(agent, profile, project, model, effort);
    return spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  }

  /** Pipe a process into the session. Guards on session.proc so a respawned
      session's stale process can't write into the journal or close the WS. */
  private wire(session: Session, proc: ChildProcessWithoutNullStreams, profileName: string): void {
    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      if (session.proc !== proc) return;
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.onAgentLine(session, line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) =>
      console.error(`[${session.id.slice(0, 8)}:${profileName}]`, chunk.toString().trimEnd()),
    );
    proc.on("exit", (code) => {
      if (session.proc !== proc) return;
      session.exited = true;
      session.ws?.close(4001, `agent exited (${code ?? "signal"})`);
    });
  }

  create(profile: Profile, project: Project, model?: string, effort?: string): Session {
    const proc = this.spawnProc(profile, project, model, effort);
    const session: Session = {
      id: randomUUID(),
      profileId: profile.id,
      projectId: project.id,
      agentId: profile.agentId,
      model: model || profile.defaultModel || "",
      effort: effort ?? "",
      title: "New thread",
      createdAt: Date.now(),
      journal: [],
      proc,
      ws: null,
      detachedAt: Date.now(),
      exited: false,
      promptActive: false,
      pendingPrompts: new Set(),
      pendingNews: new Set(),
    };
    this.sessions.set(session.id, session);
    this.wire(session, proc, profile.name);
    this.persist();
    return session;
  }

  /**
   * Swap the session's agent process for one spawned with a different
   * profile/model/effort (same project) — also the revive path for sessions
   * whose process is gone (idle-retired or pre-restart). The journal is
   * reset — the client re-handshakes and restores the conversation via ACP
   * session/load, and that replay becomes the new canonical journal.
   */
  respawn(id: string, profile: Profile, project: Project, model?: string, effort?: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error("unknown session");
    const oldProc = session.proc;
    const proc = this.spawnProc(profile, project, model, effort);
    session.proc = proc; // flips the generation guard before the old proc dies
    if (!session.exited) oldProc?.kill();
    session.exited = false;
    session.profileId = profile.id;
    session.agentId = profile.agentId;
    session.model = model || profile.defaultModel || "";
    session.effort = effort ?? "";
    session.journal = [];
    session.pendingPrompts.clear();
    session.pendingNews.clear();
    session.promptActive = false;
    this.wire(session, proc, profile.name);
    this.persist();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      profileId: s.profileId,
      projectId: s.projectId,
      agentId: s.agentId,
      model: s.model,
      effort: s.effort,
      title: s.title,
      acpSessionId: s.acpSessionId,
      createdAt: s.createdAt,
      attached: s.ws !== null,
      exited: s.exited,
      promptActive: s.promptActive,
      cursor: s.journal.length,
    }));
  }

  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.ws?.close(4000, "session killed");
    const proc = session.proc;
    session.proc = null;
    if (!session.exited) proc?.kill();
    this.sessions.delete(id);
    this.persist();
    return true;
  }

  /** Attach a WebSocket; replays agent frames after `cursor`, then pipes live. */
  attach(id: string, ws: WebSocket, cursor = 0): boolean {
    const session = this.sessions.get(id);
    if (!session || session.exited) return false;
    session.ws?.close(4002, "replaced by new connection");
    session.ws = ws;
    session.detachedAt = null;
    for (const entry of session.journal.slice(cursor)) {
      if (entry.d === "a") ws.send(entry.line);
    }
    ws.on("message", (data) => {
      const line = data.toString();
      this.onClientLine(session, line);
    });
    ws.on("close", () => {
      if (session.ws === ws) {
        session.ws = null;
        session.detachedAt = Date.now();
      }
    });
    return true;
  }

  private onAgentLine(session: Session, line: string): void {
    session.journal.push({ d: "a", line });
    let turnEndedUsage: unknown = undefined;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "session/request_permission" && !session.ws) {
        this.events.onPermissionRequest?.(session);
      }
      if (msg.method === undefined && msg.id !== undefined) {
        if (session.pendingNews.delete(msg.id) && msg.result?.sessionId) {
          session.acpSessionId = msg.result.sessionId;
          this.persist();
        }
        if (session.pendingPrompts.delete(msg.id) && session.pendingPrompts.size === 0) {
          session.promptActive = false;
          turnEndedUsage = msg.result?.usage ?? null;
        }
      }
    } catch {
      // not JSON — pipe through untouched
    }
    session.ws?.send(line);
    if (turnEndedUsage !== undefined) {
      // The prompt's requester may be a dead connection (client reattached
      // mid-turn): a synthetic notification carries turn end + usage to
      // whoever is listening now, and into the journal for later replays.
      // Emitted after the response frame so live and replay order match.
      this.emitToClient(session, {
        jsonrpc: "2.0",
        method: "_daedalus/turn_ended",
        params: { sessionId: session.acpSessionId, usage: turnEndedUsage },
      });
      if (!session.ws) this.events.onTurnEnd?.(session);
    }
  }

  /** Journal + send a server-synthesized agent->client notification. */
  private emitToClient(session: Session, msg: object): void {
    const line = JSON.stringify(msg);
    session.journal.push({ d: "a", line });
    session.ws?.send(line);
  }

  private onClientLine(session: Session, line: string): void {
    session.journal.push({ d: "c", line });
    try {
      const msg = JSON.parse(line);
      if (msg.method === "session/new" && msg.id !== undefined) session.pendingNews.add(msg.id);
      if (msg.method === "session/prompt" && msg.id !== undefined) {
        session.pendingPrompts.add(msg.id);
        session.promptActive = true;
        if (session.title === "New thread") {
          const text = (msg.params?.prompt ?? [])
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join(" ")
            .trim();
          if (text) {
            session.title = text.slice(0, 60);
            this.persist();
          }
        }
      }
    } catch {
      // not JSON — pipe through untouched
    }
    if (!session.exited) session.proc?.stdin.write(line + "\n");
  }
}
