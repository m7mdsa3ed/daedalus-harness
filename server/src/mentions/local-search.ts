/* What the `@kb:` / `@run:` / `@term:` menus offer: this project's knowledge
   entries, recent workflow and routine runs, and recent `!` commands — titles
   and one-line facts, never the content (the resolvers read that at send). */
import { recentKnowledge } from "./resolvers/kb.js";
import { recentRuns } from "./resolvers/run.js";
import { recentShellRuns } from "./resolvers/term.js";

export type LocalSearchKind = "kb" | "run" | "term";

export interface LocalMatch {
  ref: string;
  label: string;
  description?: string;
  aside?: string;
}

const LIMIT = 12;
const short = (id: string) => id.slice(0, 8);
const ago = (ms: number) => {
  const s = Math.max(Math.round((Date.now() - ms) / 1000), 0);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86_400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86_400)}d ago`;
};

export async function searchLocal(projectId: string, sessionId: string | undefined, kind: LocalSearchKind, q: string): Promise<LocalMatch[]> {
  const needle = q.trim().toLowerCase();
  const has = (...parts: (string | undefined)[]) => !needle || parts.join(" ").toLowerCase().includes(needle);
  switch (kind) {
    case "kb":
      return (await recentKnowledge(projectId))
        .filter((e) => has(e.title, e.tags?.join(" "), e.content))
        .slice(0, LIMIT)
        .map((e) => ({ ref: short(e.id), label: e.title, description: e.tags?.join(", ") || undefined, aside: ago(e.updatedAt) }));
    case "run":
      return (await recentRuns(projectId, 30))
        .filter((r) => has(r.name, r.status, r.id))
        .slice(0, LIMIT)
        .map((r) => ({ ref: short(r.id), label: r.name, description: `${r.kind} · ${r.status}`, aside: ago(r.at) }));
    case "term": {
      const runs = await recentShellRuns(projectId, undefined, 30);
      const rows: LocalMatch[] = [];
      const last = runs.find((r) => r.sessionId === sessionId) ?? runs[0];
      if (last && has("last", last.command)) rows.push({ ref: "last", label: "last", description: last.command, aside: ago(last.at) });
      for (const r of runs) {
        if (has(r.command)) rows.push({ ref: short(r.shellId), label: r.command, description: r.exitCode === 0 ? "exit 0" : r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}`, aside: ago(r.at) });
      }
      return rows.slice(0, LIMIT);
    }
  }
}
