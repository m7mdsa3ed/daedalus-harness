import type { WireError } from "./protocol.js";

/**
 * The rolling tail of an agent's stderr — the ring itself.
 *
 * The state lives on the Session (see the field comments in sessions.ts:
 * `stderr` is the retained tail, `stderrCount` the monotonic total ever
 * written, `stderrMark` the count when the running turn's prompt was
 * dispatched); this module owns every read and write of it, so the manager
 * only decides *when* — a chunk arrived, a turn started, a process was
 * replaced.
 */
export interface StderrState {
  stderr: string[];
  stderrCount: number;
  stderrMark: number;
}

/** How much of the agent's stderr to keep. Enough for a stack trace, bounded so
    a chatty agent can't grow a session without limit. */
const STDERR_TAIL_LINES = 200;

export function pushStderr(session: StderrState, text: string): void {
  const lines = text.split("\n");
  session.stderr.push(...lines);
  session.stderrCount += lines.length;
  if (session.stderr.length > STDERR_TAIL_LINES) {
    session.stderr.splice(0, session.stderr.length - STDERR_TAIL_LINES);
  }
}

/** Mark where this turn's stderr starts, so a failure is explained by its own
    output and not the previous turn's. */
export function markTurnStderr(session: StderrState): void {
  session.stderrMark = session.stderrCount;
}

/** What the agent printed since the running turn began — the part of stderr
    that can honestly be blamed on this failure, bounded by what we still hold. */
function stderrSinceMark(session: StderrState): string {
  const since = Math.min(session.stderrCount - session.stderrMark, session.stderr.length);
  return since > 0 ? session.stderr.slice(-since).join("\n").trim() : "";
}

/**
 * Attach the agent's own output to an error before it reaches the client.
 * "Internal error" is a code, not an explanation; the explanation was on
 * stderr, and this is the only place that has both.
 */
export function enrichError(session: StderrState, error: WireError): WireError {
  const stderr = stderrSinceMark(session);
  if (!stderr) return error;
  const { data } = error;
  const merged =
    data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), stderr }
      : data === undefined
        ? { stderr }
        : { details: data, stderr };
  return { ...error, data: merged };
}

/** Reset with the process: a new spawn's failures must not be explained by the
    old one's output. */
export function resetStderr(session: StderrState): void {
  session.stderr = [];
  session.stderrCount = 0;
  session.stderrMark = 0;
}
