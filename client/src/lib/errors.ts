// One place that turns anything thrown in this app into something a person can
// read. Three kinds of failure reach the UI and none of them stringify well:
//
//   - `AgentError` from lib/thread-socket — `String(err)` yields "AgentError:
//     Internal error", which is the JSON-RPC code's generic label and nothing
//     else. The cause the agent actually reported lives in `data` (including the
//     stderr the server splices in), and that is the part worth seeing.
//   - `ApiError` from lib/settings — HTTP status plus whatever the server put in
//     the body (a message, or a zod issue list).
//   - Everything else — network failures, aborts, plain Errors, thrown strings.
//
// describeError() normalizes all of them to { title, detail }; reportError()
// is the toast form. Nothing in the app should call `String(err)` on a caught
// value again.
import { toast } from "@/lib/toast"
import { ApiError } from "./settings"

export interface ErrorInfo {
  /** One line, safe as a toast title or a transcript headline. */
  title: string
  /** The rest — server body, JSON-RPC `data`, stack. May be long/multi-line. */
  detail?: string
  /** JSON-RPC code or HTTP status, when the failure carried one. */
  code?: number
  /** Rough class — callers use it to decide whether a retry makes sense. */
  kind: "rpc" | "http" | "network" | "cancelled" | "unknown"
}

/** JSON-RPC codes, said in terms of what actually went wrong for the user.
    -32000/-32002 are ACP's own extensions to the standard range. */
const RPC_TITLES: Record<number, string> = {
  [-32700]: "The agent sent malformed JSON",
  [-32600]: "The agent rejected the request as invalid",
  [-32601]: "The agent doesn't support that request",
  [-32602]: "The agent rejected the request's parameters",
  [-32603]: "The agent hit an internal error",
  [-32800]: "The request was cancelled",
  [-32000]: "The agent needs authentication",
  [-32002]: "The agent couldn't find that resource",
}

/** The generic message the SDK builds for each code, so we can tell a bare
    "Internal error" from an "Internal error: <the actual cause>" and keep the
    tail instead of throwing it away. */
const RPC_STEMS: Record<number, string> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not found",
  [-32602]: "Invalid params",
  [-32603]: "Internal error",
  [-32800]: "Request cancelled",
  [-32000]: "Authentication required",
  [-32002]: "Resource not found",
}

/** Duck-typed rather than `instanceof`: the value may be an `AgentError` from
    lib/thread-socket, or a plain `{code, message, data}` straight off a
    `turn_ended` event, and still be the thing we mean. The `instanceof Error`
    guard keeps DOMException — which also carries a legacy numeric `code` —
    out, so anything that IS an Error has to name itself. */
function asRpcError(err: unknown): { code: number; message: string; data?: unknown } | null {
  if (!err || typeof err !== "object") return null
  const e = err as { code?: unknown; message?: unknown; data?: unknown; name?: unknown }
  if (typeof e.code !== "number" || typeof e.message !== "string") return null
  if (e.name !== "RequestError" && e.name !== "AgentError" && err instanceof Error) return null
  return { code: e.code, message: e.message, data: e.data }
}

/** Pull the human-readable part out of a JSON-RPC `data` payload. Agents put
    the real cause under varying keys; anything else is shown as formatted JSON
    rather than "[object Object]". */
function dataDetail(data: unknown): string | undefined {
  if (data == null) return undefined
  if (typeof data === "string") return data.trim() || undefined
  if (typeof data !== "object") return String(data)
  const record = data as Record<string, unknown>

  let said: string | undefined
  for (const key of ["details", "detail", "message", "error", "reason", "stack"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      said = value.trim()
      break
    }
  }

  // The server attaches the agent's stderr under `stderr` (see
  // SessionManager.enrichError). It is usually the ONLY thing that explains an
  // "Internal error", so it is appended rather than competing for first place.
  const stderr = typeof record.stderr === "string" ? record.stderr.trim() : undefined
  if (said || stderr) {
    return joinDetail(said, stderr && stderr !== said ? `Agent output:\n${stderr}` : undefined)
  }

  try {
    const json = JSON.stringify(data, null, 2)
    return json === "{}" ? undefined : json
  } catch {
    return undefined
  }
}

/** Zod's issue list, as the server returns it from a failed safeParse. */
function issuesDetail(body: unknown): string | undefined {
  if (!Array.isArray(body)) return undefined
  const lines = body
    .map((issue) => {
      if (!issue || typeof issue !== "object") return null
      const { path, message } = issue as { path?: unknown; message?: unknown }
      if (typeof message !== "string") return null
      const where = Array.isArray(path) && path.length ? `${path.join(".")}: ` : ""
      return `${where}${message}`
    })
    .filter((line): line is string => line !== null)
  return lines.length ? lines.join("\n") : undefined
}

function joinDetail(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((p): p is string => !!p && p.trim().length > 0)
  // The same sentence often arrives twice (message tail == data.details).
  const unique = kept.filter((p, i) => kept.indexOf(p) === i)
  return unique.length ? unique.join("\n\n") : undefined
}

export function describeError(err: unknown): ErrorInfo {
  const rpc = asRpcError(err)
  if (rpc) {
    const stem = RPC_STEMS[rpc.code]
    // "Internal error: boom" -> keep "boom"; bare "Internal error" -> nothing.
    const tail =
      stem && rpc.message.startsWith(stem)
        ? rpc.message.slice(stem.length).replace(/^:\s*/, "").trim()
        : rpc.message.trim()
    return {
      title: RPC_TITLES[rpc.code] ?? `The agent returned an error (${rpc.code})`,
      detail: joinDetail(tail || undefined, dataDetail(rpc.data)),
      code: rpc.code,
      kind: rpc.code === -32800 ? "cancelled" : "rpc",
    }
  }

  if (err instanceof ApiError) {
    return {
      title: err.status === 0 ? "Can't reach the server" : `${err.title} (${err.status})`,
      detail: joinDetail(issuesDetail(err.body) ?? err.serverMessage, err.status ? err.path : undefined),
      code: err.status || undefined,
      kind: err.status === 0 ? "network" : "http",
    }
  }

  if (err instanceof DOMException && err.name === "AbortError") {
    return { title: "The request was cancelled", kind: "cancelled" }
  }

  // Browsers report every unreachable-host/CORS/offline failure this way.
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) {
    return {
      title: "Can't reach the server",
      detail: "The request never completed — the server may be down, or the URL unreachable.",
      kind: "network",
    }
  }

  if (err instanceof Error) {
    const stack = err.stack && err.stack.includes(err.message) ? err.stack : undefined
    return {
      title: err.message || err.name || "Something went wrong",
      detail: import.meta.env.DEV ? stack : undefined,
      kind: "unknown",
    }
  }

  if (typeof err === "string" && err.trim()) return { title: err.trim(), kind: "unknown" }
  return { title: "Something went wrong", detail: dataDetail(err), kind: "unknown" }
}

/** A failure prepared for a surface that will hold it: same normalization as
    the toast, minus the toast. `text` is the untruncated clipboard form, so a
    note that draws this needs nothing but the object. */
export interface InlineError extends ErrorInfo {
  /** Names the action that failed — the headline, exactly as in a toast. */
  context?: string
  text: string
}

/**
 * The inline counterpart of `reportError`: normalize, log, mark reported — and
 * hand the result back to be *drawn* rather than raising a card that floats
 * away in a corner.
 *
 * This exists because a toast is the wrong instrument for a failure inside a
 * dialog or a form. The user's eyes are in the modal they opened, the toast is
 * bottom-trailing behind it, and the thing they were doing gives no sign it did
 * not happen — a scan that answers nothing and a scan that failed look
 * identical. A failure belongs next to the control that caused it, for the same
 * reason `actions.recordError` puts a turn's failure in the transcript instead
 * of over it.
 *
 * Returns null for a cancel the user asked for, which is not news here either —
 * so an aborted request leaves no banner behind.
 */
export function captureError(err: unknown, context?: string): InlineError | null {
  const info = describeError(err)
  console.error(`[${context ?? "error"}]`, err)
  if (info.kind === "cancelled") return null
  markReported(err)
  return { ...info, context, text: errorText(err, context) }
}

/** The whole thing on one clipboard-shaped string. */
export function errorText(err: unknown, context?: string): string {
  const info = describeError(err)
  return [context, info.title, info.detail].filter(Boolean).join("\n")
}

/** A query's error, prepared for the surface that is drawing the empty state.
    Same normalization as `captureError`, minus the console line and the
    reported-mark: a query retries on its own schedule, so each failed attempt
    is not a new event worth logging, and nothing here is unhandled. Returns
    null while the last failure was a cancel (the caller's own refetch). */
export function inlineFromQuery(err: unknown, context?: string): InlineError | null {
  if (!err) return null
  const info = describeError(err)
  if (info.kind === "cancelled") return null
  return { ...info, context, text: errorText(err, context) }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Report a failure the transient way. `context` names the action that failed
 * ("Couldn't send the message") and becomes the headline — the normalized
 * title and detail go underneath, with the untruncated text one click away.
 * Returns the ErrorInfo so callers can also record it somewhere permanent.
 */
export function reportError(err: unknown, context?: string): ErrorInfo {
  const info = describeError(err)
  console.error(`[${context ?? "error"}]`, err)
  // A cancel the user asked for is not news.
  if (info.kind === "cancelled") return info

  markReported(err)
  const body = joinDetail(context ? info.title : undefined, info.detail)
  const full = errorText(err, context)
  toast.error(context ?? info.title, {
    description: body ? truncate(body, 400) : undefined,
    duration: 10_000,
    action: {
      label: "Copy",
      onClick: () => void writeClipboard(full).catch(() => {}),
    },
  })
  return info
}

/**
 * One toast for the whole of an operation: a spinner while it runs, then the
 * same card becomes the outcome. This is `toast.promise` with the failure
 * branch wired through `describeError`, so a rejected job reads exactly like
 * the toast `reportError` would have raised for it — same headline, same
 * detail, same Copy — instead of the bare `String(err)` a promise toast
 * usually degrades to.
 *
 * Use it wherever the work takes long enough to notice (a backup, an import,
 * a save that crosses the network): a success toast on its own can only say
 * that something finished, never that it had started.
 *
 * The rejection is passed on, so a caller can still clean up — but it is
 * marked reported, so neither the global net nor a `.catch(reportError)` says
 * it twice.
 */
export function reportPromise<T>(
  promise: Promise<T>,
  {
    loading,
    success,
    context,
  }: {
    loading: string
    /** The settled headline — a function when it wants to count what it got. */
    success: string | ((value: T) => string | { title: string; description?: string })
    /** Names the action that failed, e.g. "Couldn't export the backup". */
    context?: string
  }
): Promise<T> {
  return toast.promise(promise, {
    loading,
    success: (value: T) => (typeof success === "function" ? success(value) : success),
    error: (err: unknown) => {
      const info = describeError(err)
      console.error(`[${context ?? "error"}]`, err)
      markReported(err)
      // A cancel the user asked for is not news — but the loading toast is
      // already on screen and something has to replace it, so it says the
      // plain fact and goes away quickly rather than reporting a failure.
      if (info.kind === "cancelled") return { title: "Cancelled", duration: 2500 }
      const body = joinDetail(context ? info.title : undefined, info.detail)
      const full = errorText(err, context)
      return {
        title: context ?? info.title,
        description: body ? truncate(body, 400) : undefined,
        duration: 10_000,
        action: {
          label: "Copy",
          onClick: () => void writeClipboard(full).catch(() => {}),
        },
      }
    },
  })
}

/**
 * Catch what nothing else does. Called once at startup: a rejected promise with
 * no `.catch`, or a throw from outside React's render path, is a bug we want to
 * hear about rather than a silent no-op — but the user is not debugging, so it
 * gets one deliberately vague toast and the real thing goes to the console.
 *
 * Rejections the app has already reported are marked (see `markReported`) so a
 * caught-and-toasted failure that is also rethrown doesn't toast twice.
 */
const reported = new WeakSet<object>()

/** Mark a value as already surfaced to the user, so the global net skips it. */
export function markReported(err: unknown): void {
  if (err && typeof err === "object") reported.add(err)
}

export function installGlobalErrorReporting(): void {
  addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason
    if (reason && typeof reason === "object" && reported.has(reason)) return
    const info = describeError(reason)
    if (info.kind === "cancelled") return
    console.error("[unhandled rejection]", reason)
    toast.error("Something failed in the background", {
      description: truncate([info.title, info.detail].filter(Boolean).join(" — "), 300),
      duration: 8000,
    })
  })

  addEventListener("error", (event) => {
    // Resource load failures (a missing image) also fire here and are not ours.
    if (event.error === undefined && event.target !== window) return
    console.error("[uncaught]", event.error ?? event.message)
  })
}
import { writeClipboard } from "@/lib/clipboard"
