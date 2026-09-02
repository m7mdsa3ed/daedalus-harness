import type * as acp from "./acp.js";
import type { Session } from "./session.js";

export type PermissionGroup = "edit" | "execute" | "mcp";

export interface PermissionAsk {
  toolCallId: string;
  toolName: string;
  title: string;
  kind: acp.ToolKind;
  rawInput?: Record<string, unknown>;
}

/** Thrown when the user rejects; surfaces to the model as the tool's failure. */
export class PermissionRejected extends Error {
  constructor(title: string) {
    super(`The user rejected permission to run: ${title}`);
    this.name = "PermissionRejected";
  }
}

const OPTIONS: acp.PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/* The ask is a wrapper inside each gated tool's execute — not ai's
   toolApproval, which round-trips through the model — because the answer has
   to come synchronously from the client, and its `toolCall.kind` is what the
   harness's autonomy policy switches on. "Always" answers stick per tool name
   for the life of the session. */
export async function checkPermission(
  ctx: acp.AgentContext,
  session: Session,
  group: PermissionGroup,
  ask: PermissionAsk,
): Promise<void> {
  if (session.mode === "bypassPermissions") return;
  if (session.mode === "acceptEdits" && group === "edit") return;
  if (session.alwaysAllow.has(ask.toolName)) return;
  if (session.alwaysReject.has(ask.toolName)) throw new PermissionRejected(ask.title);

  /* Raced against the turn's abort: session.cancel() has to unblock a pending
     ask, because once the turn is being torn down the client's answer may
     never arrive. */
  const signal = session.abort?.signal;
  if (signal?.aborted) throw new PermissionRejected(ask.title);
  const response = await abortable(
    ctx.request("session/request_permission", {
      sessionId: session.id,
      toolCall: {
        toolCallId: ask.toolCallId,
        title: ask.title,
        kind: ask.kind,
        status: "pending",
        rawInput: ask.rawInput,
      },
      options: OPTIONS,
    }),
    signal,
    () => new PermissionRejected(ask.title),
  );
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") {
    session.cancel();
    throw new PermissionRejected(ask.title);
  }
  switch (outcome.optionId) {
    case "allow":
      return;
    case "allow_always":
      session.alwaysAllow.add(ask.toolName);
      return;
    case "reject_always":
      session.alwaysReject.add(ask.toolName);
      throw new PermissionRejected(ask.title);
    default:
      throw new PermissionRejected(ask.title);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort: () => Error): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(v);
      },
      (err) => {
        signal.removeEventListener("abort", abort);
        reject(err as Error);
      },
    );
  });
}
