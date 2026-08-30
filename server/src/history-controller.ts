import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import {
  db,
  historyBranches,
  historyCheckpoints,
} from "./db/index.js";
import type { AcpBridge } from "./acp-bridge.js";
import type { HistoryState, HistoryStrategy } from "./protocol.js";
import type { WorkspaceManifest } from "./workspace-history.js";
import { WorkspaceSnapshotService } from "./workspace-history.js";

export interface CheckpointRecord {
  id: string;
  turnId: string;
  sessionId: string;
  promptText: string;
  parentAcpSessionId: string;
  childAcpSessionId: string;
  preSnapshotId: string;
  postManifest: WorkspaceManifest | null;
  parentCheckpointId: string | null;
  branchId: string | null;
  status: string;
  createdAt: number;
  completedAt: number | null;
}

export interface HistoryBridge {
  historyStrategy: HistoryStrategy;
  acpSessionId: string | null;
  forkCheckpoint(cwd: string, mcpServers: import("@agentclientprotocol/sdk").McpServer[]): Promise<string>;
}

export class HistoryController {
  readonly snapshots: WorkspaceSnapshotService;
  private readonly maxRetainedBranches: number;

  constructor(snapshots = new WorkspaceSnapshotService(), maxRetainedBranches = 20) {
    this.snapshots = snapshots;
    this.maxRetainedBranches = Math.max(1, maxRetainedBranches);
  }

  strategy(bridge: Pick<AcpBridge, "historyStrategy"> | null): HistoryStrategy {
    return bridge?.historyStrategy ?? "unsupported";
  }

  async begin(
    sessionId: string,
    bridge: HistoryBridge,
    cwd: string,
    mcpServers: import("@agentclientprotocol/sdk").McpServer[],
    promptText: string,
  ): Promise<CheckpointRecord> {
    if (bridge.historyStrategy !== "fork-checkpoint") {
      throw new Error("This agent does not advertise a supported history checkpoint capability.");
    }
    const parentAcpSessionId = bridge.acpSessionId;
    if (!parentAcpSessionId) throw new Error("The agent session is not ready for checkpointing.");
    const snapshot = this.snapshots.capture(cwd);
    const childAcpSessionId = await bridge.forkCheckpoint(cwd, mcpServers);
    const latest = this.latestActive(sessionId);
    const now = Date.now();
    const record: CheckpointRecord = {
      id: randomUUID(),
      turnId: randomUUID(),
      sessionId,
      promptText,
      parentAcpSessionId,
      childAcpSessionId,
      preSnapshotId: snapshot.id,
      postManifest: null,
      parentCheckpointId: latest?.id ?? null,
      branchId: null,
      status: "in_progress",
      createdAt: now,
      completedAt: null,
    };
    db.insert(historyCheckpoints).values(record).run();
    return record;
  }

  complete(turnId: string, manifest: WorkspaceManifest): void {
    db.update(historyCheckpoints)
      .set({ status: "completed", completedAt: Date.now(), postManifest: manifest })
      .where(eq(historyCheckpoints.turnId, turnId))
      .run();
  }

  refreshActiveHead(sessionId: string, manifest: WorkspaceManifest): void {
    const latest = this.latestActive(sessionId);
    if (!latest) return;
    db.update(historyCheckpoints)
      .set({ postManifest: manifest })
      .where(eq(historyCheckpoints.id, latest.id))
      .run();
  }

  fail(turnId: string): void {
    db.update(historyCheckpoints)
      .set({ status: "failed", completedAt: Date.now() })
      .where(eq(historyCheckpoints.turnId, turnId))
      .run();
  }

  checkpoint(sessionId: string, checkpointId: string): CheckpointRecord | null {
    const row = db.select().from(historyCheckpoints).where(and(
      eq(historyCheckpoints.id, checkpointId),
      eq(historyCheckpoints.sessionId, sessionId),
    )).get();
    return row ? this.toCheckpoint(row) : null;
  }

  latestActive(sessionId: string): CheckpointRecord | null {
    const row = db.select().from(historyCheckpoints).where(and(
      eq(historyCheckpoints.sessionId, sessionId),
      isNull(historyCheckpoints.branchId),
      eq(historyCheckpoints.status, "completed"),
    )).orderBy(desc(historyCheckpoints.createdAt)).get();
    return row ? this.toCheckpoint(row) : null;
  }

  retainActiveBranch(
    sessionId: string,
    from: CheckpointRecord,
    acpSessionId: string,
    workspaceSnapshotId: string,
  ): string {
    const branchId = randomUUID();
    db.insert(historyBranches).values({
      id: branchId,
      sessionId,
      sourceCheckpointId: from.id,
      acpSessionId,
      workspaceSnapshotId,
      label: from.promptText.slice(0, 80) || "Discarded branch",
      status: "retained",
      createdAt: Date.now(),
      recoveredAt: null,
    }).run();
    db.update(historyCheckpoints)
      .set({ branchId, status: "discarded" })
      .where(and(
        eq(historyCheckpoints.sessionId, sessionId),
        isNull(historyCheckpoints.branchId),
        gte(historyCheckpoints.createdAt, from.createdAt),
      ))
      .run();
    this.pruneBranches(sessionId);
    return branchId;
  }

  retainHead(
    sessionId: string,
    sourceCheckpointId: string,
    acpSessionId: string,
    workspaceSnapshotId: string,
    label: string,
  ): string {
    const branchId = randomUUID();
    db.insert(historyBranches).values({
      id: branchId,
      sessionId,
      sourceCheckpointId,
      acpSessionId,
      workspaceSnapshotId,
      label: label.slice(0, 80) || "Retained branch",
      status: "retained",
      createdAt: Date.now(),
      recoveredAt: null,
    }).run();
    this.pruneBranches(sessionId);
    return branchId;
  }

  recoverBranch(sessionId: string, branchId: string): {
    id: string;
    acpSessionId: string;
    workspaceSnapshotId: string;
    sourceCheckpointId: string;
  } | null {
    const branch = db.select().from(historyBranches).where(and(
      eq(historyBranches.id, branchId),
      eq(historyBranches.sessionId, sessionId),
      eq(historyBranches.status, "retained"),
    )).get();
    if (!branch) return null;
    return branch;
  }

  markRecovered(sessionId: string, branchId: string): void {
    const branch = db.select().from(historyBranches).where(eq(historyBranches.id, branchId)).get();
    db.update(historyCheckpoints)
      .set({ branchId: null, status: "completed" })
      .where(and(eq(historyCheckpoints.sessionId, sessionId), eq(historyCheckpoints.branchId, branchId)))
      .run();
    db.update(historyBranches)
      .set({ status: "recovered", recoveredAt: Date.now() })
      .where(eq(historyBranches.id, branchId))
      .run();
    if (branch) this.snapshots.delete(branch.workspaceSnapshotId);
  }

  private pruneBranches(sessionId: string): void {
    const retained = db.select().from(historyBranches).where(and(
      eq(historyBranches.sessionId, sessionId),
      eq(historyBranches.status, "retained"),
    )).orderBy(desc(historyBranches.createdAt)).all();
    for (const branch of retained.slice(this.maxRetainedBranches)) {
      db.update(historyCheckpoints)
        .set({ status: "expired" })
        .where(eq(historyCheckpoints.branchId, branch.id))
        .run();
      db.delete(historyBranches).where(eq(historyBranches.id, branch.id)).run();
      this.snapshots.delete(branch.workspaceSnapshotId);
    }
  }

  state(sessionId: string, strategy: HistoryStrategy, busy: boolean, conflict?: string): HistoryState {
    const checkpoints = db.select().from(historyCheckpoints).where(and(
      eq(historyCheckpoints.sessionId, sessionId),
      isNull(historyCheckpoints.branchId),
      eq(historyCheckpoints.status, "completed"),
    )).orderBy(asc(historyCheckpoints.createdAt)).all();
    const branches = db.select().from(historyBranches).where(and(
      eq(historyBranches.sessionId, sessionId),
      eq(historyBranches.status, "retained"),
    )).orderBy(desc(historyBranches.createdAt)).all();
    return {
      strategy,
      available: strategy !== "unsupported",
      busy,
      ...(strategy === "unsupported" ? { reason: "This agent does not advertise session/fork or native revert." } : {}),
      ...(conflict ? { conflict } : {}),
      checkpoints: checkpoints.map((row) => ({
        id: row.id,
        turnId: row.turnId,
        promptText: row.promptText,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        status: row.status,
      })),
      branches: branches.map((row) => ({
        id: row.id,
        label: row.label,
        sourceCheckpointId: row.sourceCheckpointId,
        createdAt: row.createdAt,
      })),
    };
  }

  private toCheckpoint(row: typeof historyCheckpoints.$inferSelect): CheckpointRecord {
    return { ...row, postManifest: row.postManifest as WorkspaceManifest | null };
  }
}
