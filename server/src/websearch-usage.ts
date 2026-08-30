import { randomUUID } from "node:crypto";
import { and, count, desc, eq, lt } from "drizzle-orm";
import type * as acp from "@agentclientprotocol/sdk";
import type { SessionUpdate } from "./protocol.js";
import { db, webSearchUsage } from "./db/index.js";

export type WebSearchUsageTool = "search" | "fetch";

export interface WebSearchUsageContext {
  sessionId: string;
  threadTitle: string;
  profileId: string;
  profileName: string;
  projectId: string;
  projectName: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function toolOf(update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" }>): WebSearchUsageTool | null {
  const input = asRecord(update.rawInput);
  const meta = asRecord(update._meta);
  const claude = stringOf(asRecord(meta?.claudeCode)?.toolName)?.toLowerCase();
  const title = update.title.trim().toLowerCase();
  const server = stringOf(input?.server)?.toLowerCase();
  const tool = stringOf(input?.tool)?.toLowerCase();
  const identity = server === "web-search" && tool
    ? `mcp.${server}.${tool}`
    : (claude ?? title);

  if (identity === "mcp.web-search.web_search" || identity === "mcp__web-search__web_search") return "search";
  if (identity === "mcp.web-search.web_fetch" || identity === "mcp__web-search__web_fetch") return "fetch";
  return null;
}

const isTerminalStatus = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/**
 * Record live calls only. SessionManager excludes ACP history replay before
 * calling this.
 *
 * `live` is the session's set of in-flight search/fetch toolCallIds, owned by
 * the caller and maintained here: without it every streamed frame of every
 * tool on a websearch-enabled thread issued a no-op UPDATE. A `tool_call` that
 * isn't a search/fetch never touches the database, and a `tool_call_update`
 * for a call not in the set is dropped before any SQL is built.
 */
export function recordWebSearchUsage(
  context: WebSearchUsageContext,
  update: SessionUpdate,
  live: Set<string>,
): void {
  if (update.sessionUpdate === "tool_call") {
    const tool = toolOf(update);
    if (!tool) return;
    if (isTerminalStatus(update.status ?? "pending")) live.delete(update.toolCallId);
    else live.add(update.toolCallId);
    const now = Date.now();
    const status = update.status ?? "pending";
    db.insert(webSearchUsage)
      .values({
        id: randomUUID(),
        sessionId: context.sessionId,
        toolCallId: update.toolCallId,
        tool,
        status,
        threadTitle: context.threadTitle,
        profileId: context.profileId,
        profileName: context.profileName,
        projectId: context.projectId,
        projectName: context.projectName,
        startedAt: now,
        completedAt: isTerminalStatus(status) ? now : null,
      })
      .onConflictDoUpdate({
        target: [webSearchUsage.sessionId, webSearchUsage.toolCallId],
        set: { status, completedAt: isTerminalStatus(status) ? now : null },
      })
      .run();
    return;
  }

  if (update.sessionUpdate !== "tool_call_update" || !update.status) return;
  if (!live.has(update.toolCallId)) return;
  if (isTerminalStatus(update.status)) live.delete(update.toolCallId);
  const now = Date.now();
  db.update(webSearchUsage)
    .set({
      status: update.status,
      ...(isTerminalStatus(update.status) ? { completedAt: now } : {}),
    })
    .where(and(
      eq(webSearchUsage.sessionId, context.sessionId),
      eq(webSearchUsage.toolCallId, update.toolCallId),
    ))
    .run();
}

/** Drop ledger rows older than `cutoff` (epoch ms). Rides the same hourly
    sweep as the journal retention — the ledger is metadata about transcripts
    whose archives are pruned on the same clock. */
export function pruneWebSearchUsage(cutoff: number): number {
  return db.delete(webSearchUsage).where(lt(webSearchUsage.startedAt, cutoff)).run().changes;
}

export function getWebSearchUsage(limit = 50) {
  const grouped = db
    .select({ tool: webSearchUsage.tool, status: webSearchUsage.status, total: count() })
    .from(webSearchUsage)
    .groupBy(webSearchUsage.tool, webSearchUsage.status)
    .all();
  const totals = { searches: 0, fetches: 0, failed: 0 };
  for (const row of grouped) {
    if (row.tool === "search") totals.searches += row.total;
    else totals.fetches += row.total;
    if (row.status === "failed" || row.status === "cancelled") totals.failed += row.total;
  }
  const recent = db
    .select()
    .from(webSearchUsage)
    .orderBy(desc(webSearchUsage.startedAt))
    .limit(Math.max(1, Math.min(limit, 200)))
    .all();
  return { totals, recent };
}
