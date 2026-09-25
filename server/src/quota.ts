import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { agentQuota as agentQuotaTable, db, type QuotaProbe } from "./db/index.js";
import { resolveSpawn, type AgentDef } from "./registry.js";
import { profileUsage, readProfileUsage } from "./usage-api.js";
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from "./protocol.js";
import { isVirtualProfile, type Profile } from "./profiles.js";
import type { Project } from "./projects.js";

export type { QuotaSnapshot, QuotaStatus, QuotaWindow };

/*
 * What is left of the subscription an agent is spending.
 *
 * This is the number Claude Code's `/usage` and Codex's `/status` print, and it
 * is the one the harness could not see: the transcript carries per-turn `Usage`
 * (tokens in, tokens out, cache) but a plan's five-hour and weekly windows live
 * on the account, not in any session. Neither runtime reports them over ACP —
 * there is no field for it in the protocol — so the only way to read them is to
 * ask the runtime's own CLI, out of band, the way a person would.
 *
 * Two rules shape everything below.
 *
 * **The snapshot is normalized and the raw text is kept.** Every adapter
 * produces the same `QuotaSnapshot`, so the client renders windows generically
 * and no component matches on an agent id — the same rule `lib/tools.ts` follows
 * for tool calls. But one of the two adapters parses *prose*, and prose changes
 * between releases, so `raw` always carries what the runtime actually said. A
 * wording change then degrades to "here is the report, unparsed" instead of to
 * an empty card that silently claims 0%.
 *
 * **"No quota" is an answer, not a failure.** An agent on an API key or a
 * gateway has no plan windows at all, and that is the common case in this
 * harness — a profile is usually credentials for a metered endpoint. It gets
 * `status: "api-key"` and no windows, which the UI states in words. Only a probe
 * that could not be run at all is an `error`.
 *
 * There is a second reader, and which one answers is the interesting decision.
 * A *profile* may name a usage provider of its own (`ProfileUsage`, adapters in
 * usage-api.ts) — a provider selling a coding plan, metered by that provider's
 * account API rather than by the runtime's. When it does, **it wins over the
 * agent's probe**, because the profile is what the turn was actually billed to:
 * a thread running Claude Code against a z.ai plan spends z.ai's windows, and
 * `claude -p /usage` would answer confidently about an Anthropic account that
 * turn never touched. Everything below the choice is shared — one snapshot
 * shape, one cache, one event — so nothing downstream knows which reader ran.
 */

/** Long enough for a cold CLI to boot and answer, short enough that a wedged one
    does not hold a settings page open forever. `claude -p /usage` measured ~2.3s
    once; it now also tallies the machine's local sessions before it prints, and
    measures 25–40s — past the old 30s, which failed every reading. */
const PROBE_TIMEOUT_MS = 90_000;

/** Cap on collected output, per stream — git.ts's MAX_BUFFER. A usage report is
    a screenful, so a child past this is looping, and the timeout alone would
    let it write unbounded strings into this process for the full 30s. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** How long a reading stays fresh. A quota moves on its own — there is no local
    event that invalidates it — so unlike the option probe this cache expires
    rather than being keyed by everything that could change the answer. Short
    enough to feel live next to a running turn, long enough that four tabs and a
    composer popover cost one process. */
export const QUOTA_TTL_MS = 5 * 60_000;

/**
 * Where a reading is cached.
 *
 * A probe's answer is the (profile, agent) pair's: the same agent under
 * different credentials reports different things, and two agents rarely share an
 * account. A profile provider's answer is the *profile's* alone — one provider
 * account, whatever runtime is spending it — so it keys on a fixed `:usage`
 * suffix and Claude Code and Codex on the same z.ai plan share one reading
 * instead of making the same HTTP call twice and drawing two cards.
 */
const cacheKey = (profileId: string, agentId: string) => `${profileId}:${agentId}`;
const USAGE_SUFFIX = "usage";
const keyFor = (profile: Profile, agentId: string) =>
  profileUsage(profile) ? cacheKey(profile.id, USAGE_SUFFIX) : cacheKey(profile.id, agentId);

/** In-flight probes, keyed like the cache: two tabs opening the settings page at
    once must spawn one CLI, not two. Same shape as `probe.ts`'s. */
const inflight = new Map<string, Promise<QuotaSnapshot>>();

/** The cwd a probe runs in when no project is named. Quota is account-level and
    does not vary by directory, but a child still needs somewhere to be. */
export const quotaCwd = (): Project => ({ id: "", name: "", cwd: process.cwd(), description: null });

/*
 * ── A probe is a second process on the same login, and that is a race ──
 *
 * The agent probe is not an API call: it is a whole second copy of the runtime's
 * CLI, and it reads and writes the very credentials file the live agent child is
 * reading and writing. A subscription login is OAuth with a *rotating* refresh
 * token, so two processes that both find the access token expired both present
 * the same refresh token; the provider honours one and answers the other
 * `invalid_grant`, and whichever finishes last is what the file ends up holding.
 * The account is logged out, and the user is asked to sign in again.
 *
 * Nothing here can lock against it — the agent child is not ours to coordinate
 * with, and the window is opened by exactly the thing that makes the reading
 * useful: `refreshQuota` asks at *turn end*, when the child is certainly alive.
 *
 * So the probe yields — but only while the race is possible. The refresh is
 * the race, and nobody refreshes a token with hours left on it: where the probe
 * row says where the login keeps its expiry (`QuotaProbe.login`), a token with
 * more than `LOGIN_MARGIN_MS` to live is safe to probe beside a live agent. It
 * used to yield to *every* live process, and on a machine that always has a
 * Claude Code thread open that froze the card on its first reading for good,
 * Refresh included.
 *
 * Near expiry, or with no way to tell, the stored reading is served however old
 * it is, and no CLI is spawned. A percentage that is a few minutes stale is a
 * smaller harm than an account that has to log in again.
 *
 * Deliberately by **agent id and not by (agent, profile)**: a login is a file on
 * this machine, and two profiles that set no config-dir of their own share it.
 * Over-broad costs a stale number; too narrow costs the logout this exists for.
 */
let runtimeIsLive: (agentId: string) => boolean = () => false;

/** Told by the SessionManager, which owns the child processes and is the only
    thing that knows. Left as "nothing is live" for a server without one. */
export function setRuntimeLiveCheck(fn: (agentId: string) => boolean): void {
  runtimeIsLive = fn;
}

/** How long a login's token must still have to live for a probe to run beside
    a live agent: the probe's own worst case, plus the few minutes before expiry
    in which a CLI refreshes early. */
const LOGIN_MARGIN_MS = PROBE_TIMEOUT_MS + 10 * 60_000;

/** Is the login this probe spends far enough from a refresh that no process
    will attempt one while the probe runs? False whenever it cannot tell — no
    `login` on the row, no file, no number where the row says the expiry is. */
async function loginFarFromRefresh(agent: AgentDef, env: Record<string, string>): Promise<boolean> {
  const login = agent.quotaProbe?.login;
  if (!login) return false;
  const dir = env[login.dirEnv] || process.env[login.dirEnv] || join(homedir(), login.dir);
  try {
    const data: unknown = JSON.parse(await readFile(join(dir, login.file), "utf8"));
    const expiresAt = login.expiresAt
      .split(".")
      .reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), data);
    return typeof expiresAt === "number" && expiresAt - Date.now() > LOGIN_MARGIN_MS;
  } catch {
    return false;
  }
}

/**
 * Must this reading be taken from the cache rather than by spawning?
 *
 * Only ever true of the **agent probe**: a profile provider's reading is an
 * HTTP call against a stored key, which races nothing and is always taken. And
 * only while that runtime is live *and* its login might refresh (see above).
 */
export async function probeHeldBack(
  profile: Profile,
  agent: AgentDef,
  project: Project = quotaCwd(),
): Promise<boolean> {
  if (profileUsage(profile) || !runtimeIsLive(agent.id)) return false;
  return !(await loginFarFromRefresh(agent, resolveSpawn(agent, profile, project).env));
}

/** The last thing this pair was known to be, with no probe spawned. `error` when
    there is nothing stored yet: the card says why, and it is never written to the
    cache, so the first quiet moment still takes a real reading. */
async function lastKnown(agentId: string, profileId: string): Promise<QuotaSnapshot> {
  const hit = (await db.select().from(agentQuotaTable).where(eq(agentQuotaTable.key, cacheKey(profileId, agentId))).limit(1))[0];
  if (hit) return hit.snapshot as QuotaSnapshot;
  return {
    ...failed({ agentId, profileId, source: "agent", fetchedAt: Date.now() }, new Error("not read while the runtime is running — it would race the login's own token refresh")),
  };
}

// ---------------------------------------------------------------------------
// Running the probe
// ---------------------------------------------------------------------------

interface Ran {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Run the probe binary with the agent's own resolved env and collect its output.
 *
 * The env matters and is the reason this takes a profile at all: a profile that
 * sets `CLAUDE_CONFIG_DIR`/`CODEX_HOME` points the CLI at a different account,
 * and one that sets an API key makes the same CLI report metered usage instead
 * of a plan. Probing under the resolved env is what makes the answer true of the
 * agent this profile would actually spawn.
 *
 * Two knobs, both for the JSON-RPC adapter:
 *
 *   - `write` gets the child's stdin. It is closed immediately when no adapter
 *     wants it, because a CLI reading an open stdin waits forever — and left
 *     open when one does, because closing it races the answers.
 *   - `until` is asked after every chunk whether there is anything left to wait
 *     for, and the child is killed the moment it says no. A server is not a
 *     command: `codex app-server` has answered and is still sitting there, so
 *     without this every codex reading costs the full timeout — measured at 30s
 *     for a reply that arrived in one.
 */
function run(
  probe: QuotaProbe,
  agent: AgentDef,
  profile: Profile,
  project: Project,
  write?: (stdin: NodeJS.WritableStream) => void,
  until?: (stdout: string) => boolean,
): Promise<Ran> {
  const { env, cwd } = resolveSpawn(agent, profile, project);
  return new Promise((resolve) => {
    const child = spawn(probe.command, probe.args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      finish(null);
    }, PROBE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_BUFFER) {
        stdout = stdout.slice(0, MAX_BUFFER);
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      /* Killed, not asked politely: the answers are in hand, and `close` will
         still fire and settle this with everything collected. */
      if (until?.(stdout)) {
        child.kill("SIGKILL");
        finish(0);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_BUFFER) {
        stderr = stderr.slice(0, MAX_BUFFER);
        child.kill("SIGKILL");
        finish(null);
      }
    });
    /* ENOENT for a binary that is not installed lands here, not on the exit
       path: it is the ordinary answer for "this runtime is not on this box". */
    child.on("error", (err) => {
      stderr += `${err.message}\n`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (write) write(child.stdin);
    else child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Adapter: Claude Code (`claude -p "/usage" --output-format json`)
// ---------------------------------------------------------------------------

/** `Current session: 3% used · resets Aug 31, 9:59am (Africa/Cairo)` */
const CLAUDE_SESSION_RE = /^Current session:\s*(\d+)%\s*used(?:\s*[·.-]\s*resets\s+(.+?))?\s*$/m;
/** `Current week (all models): 35% used · resets Sep 4, 12:59am (Africa/Cairo)` */
const CLAUDE_WEEK_RE = /^Current week\s*\(([^)]*)\):\s*(\d+)%\s*used(?:\s*[·.-]\s*resets\s+(.+?))?\s*$/gm;

/** `all models` → `seven_day`, `Opus` → `seven_day_opus` — the id the underlying
    account API uses for the same window, so two runtimes reporting the same
    limit agree on a key. */
const weekWindowId = (scope: string) => {
  const slug = scope.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return !slug || slug === "all_models" ? "seven_day" : `seven_day_${slug}`;
};

/**
 * Read the report `/usage` prints.
 *
 * Prose, deliberately. The structured source underneath is an undocumented
 * OAuth endpoint whose token lives in `~/.claude/.credentials.json` on Linux and
 * in the login keychain on macOS, and which would have to be refreshed by hand —
 * a second, more fragile copy of the CLI's own auth. Asking the CLI works
 * wherever the agent itself works, and the whole report is kept as `raw` so an
 * unparsed line is still readable.
 */
export function parseClaudeUsage(
  stdout: string,
): Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName" | "error"> {
  /* `--output-format json` wraps the command's text in `.result`. A plain-text
     run (someone editing the args) still parses: fall back to the whole stream. */
  let text = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as { result?: unknown }).result === "string") {
      text = (parsed as { result: string }).result;
    }
  } catch {
    /* not JSON — the raw report */
  }

  const windows: QuotaWindow[] = [];
  const session = CLAUDE_SESSION_RE.exec(text);
  if (session) {
    windows.push({
      id: "five_hour",
      label: "Current session",
      usedPercent: Number(session[1]),
      resetsLabel: session[2],
      windowMinutes: 300,
    });
  }
  CLAUDE_WEEK_RE.lastIndex = 0;
  for (let m = CLAUDE_WEEK_RE.exec(text); m; m = CLAUDE_WEEK_RE.exec(text)) {
    windows.push({
      id: weekWindowId(m[1]),
      label: `Current week (${m[1]})`,
      usedPercent: Number(m[2]),
      resetsLabel: m[3],
      windowMinutes: 7 * 24 * 60,
    });
  }

  /* The first line states which it is, and it is the only place that does. A
     window that parsed outranks it: numbers in hand mean a plan, whatever the
     prose called itself. */
  if (!windows.length && /subscription/i.test(text)) {
    /* A plan with no limit lines is the CLI failing to fetch them — it prints
       the rest of the report without them — and never a plan with no limits.
       Drawn as "no limits reported" it looked like a working card, so it is a
       failure with the report kept, and Refresh asks again. */
    return {
      status: "error",
      windows,
      raw: text,
      planName: null,
      error: "Claude Code's report came back without its limits — try Refresh.",
    };
  }
  const status: QuotaStatus = windows.length
    ? "subscription"
    : /\bapi\b|credit|console\.anthropic/i.test(text)
        ? "api-key"
        : /log ?in|not authenticated|\/login/i.test(text)
          ? "unauthenticated"
          : "error";

  return { status, windows, raw: text, planName: null };
}

// ---------------------------------------------------------------------------
// Adapter: Codex (`codex app-server`, JSON-RPC over stdio)
// ---------------------------------------------------------------------------

/** `account/rateLimits/read`'s `RateLimitWindow`, per codex's own
    `app-server generate-json-schema`. `resetsAt` is unix *seconds*. */
interface CodexWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

interface CodexRateLimits {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  planType?: string | null;
  limitName?: string | null;
  credits?: { balance?: string | null; hasCredits?: boolean; unlimited?: boolean } | null;
}

/** 300 → "5h limit", 10080 → "Weekly limit". Codex names its windows only by
    duration, so the label is derived; `limitName` wins when it has one. */
function codexWindowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    if (days === 7) return "Weekly limit";
    return days === 1 ? "Daily limit" : `${days}-day limit`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h limit`;
  return `${minutes}m limit`;
}

function codexWindow(id: string, window: CodexWindow | null | undefined, fallback: string): QuotaWindow | null {
  if (!window || typeof window.usedPercent !== "number") return null;
  return {
    id,
    label: codexWindowLabel(window.windowDurationMins, fallback),
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt ? window.resetsAt * 1000 : null,
    windowMinutes: window.windowDurationMins ?? null,
  };
}

/** What the two JSON-RPC calls answered, however they answered. */
export interface CodexAnswers {
  account?: { type?: string } | null;
  rateLimits?: CodexRateLimits | null;
  /** The error the rate-limit call returned, if it returned one. */
  rateLimitError?: string;
  accountError?: string;
}

/**
 * Fold codex's two answers into a snapshot.
 *
 * The declining case is the interesting one and it is what this machine does:
 * a codex authenticated with an API key answers `account/read` with
 * `{account:{type:"apiKey"}}` and refuses the rate-limit call outright —
 * `-32600 chatgpt authentication required to read rate limits`. That is not an
 * error to report; it is the account saying it has no plan, so it reads as
 * `api-key` with the refusal kept as the raw text.
 */
export function foldCodexQuota(answers: CodexAnswers): Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName" | "credits"> {
  const limits = answers.rateLimits;
  const windows = [
    codexWindow("primary", limits?.primary, limits?.limitName || "Primary limit"),
    codexWindow("secondary", limits?.secondary, "Secondary limit"),
  ].filter((w): w is QuotaWindow => w !== null);

  const accountType = answers.account?.type ?? "";
  const status: QuotaStatus = windows.length
    ? "subscription"
    : accountType === "apiKey"
      ? "api-key"
      : /chatgpt authentication required/i.test(answers.rateLimitError ?? "")
        ? /* Said with no account answer to go with it: still "no plan here". */
          "api-key"
        : answers.rateLimitError || answers.accountError
          ? "error"
          : "unauthenticated";

  const raw =
    answers.rateLimitError ??
    (limits ? JSON.stringify(limits, null, 2) : answers.accountError ?? JSON.stringify(answers.account ?? {}, null, 2));

  const credits = limits?.credits
    ? { balance: limits.credits.balance ?? null, unlimited: Boolean(limits.credits.unlimited) }
    : null;

  return { status, windows, raw, planName: limits?.planType ?? null, credits };
}

/** The two requests, by JSON-RPC id. `initialize` is 0 and is not an answer we
    keep — it only has to happen before the other two. */
const CODEX_ACCOUNT_ID = 1;
const CODEX_RATE_LIMITS_ID = 2;

/**
 * Read whatever the app-server has said so far.
 *
 * Line-delimited JSON, hand-rolled: this is not ACP, so the SDK's stream has
 * nothing to offer here and would only validate against the wrong schema. Run
 * over the accumulated buffer rather than incrementally, because it is also the
 * "are we done" test and a few dozen short lines cost nothing to re-read.
 */
export function collectCodexAnswers(stdout: string): CodexAnswers & { answered: Set<number> } {
  const answers: CodexAnswers & { answered: Set<number> } = { answered: new Set() };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // a partial last line; the next chunk completes it
    }
    if (msg.id === CODEX_ACCOUNT_ID) {
      answers.answered.add(CODEX_ACCOUNT_ID);
      if (msg.error) answers.accountError = msg.error.message ?? "account/read failed";
      else answers.account = (msg.result?.account as { type?: string } | undefined) ?? null;
    }
    if (msg.id === CODEX_RATE_LIMITS_ID) {
      answers.answered.add(CODEX_RATE_LIMITS_ID);
      if (msg.error) answers.rateLimitError = msg.error.message ?? "account/rateLimits/read failed";
      else answers.rateLimits = (msg.result?.rateLimits as CodexRateLimits | undefined) ?? null;
    }
  }
  return answers;
}

/** Drive `codex app-server` far enough to ask about the account, then stop. */
async function probeCodex(probe: QuotaProbe, agent: AgentDef, profile: Profile, project: Project): Promise<CodexAnswers> {
  const ran = await run(
    probe,
    agent,
    profile,
    project,
    (stdin) => {
      const send = (msg: unknown) => stdin.write(`${JSON.stringify(msg)}\n`);
      send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "daedalus", title: "Daedalus", version: "1" } },
      });
      send({ jsonrpc: "2.0", method: "initialized", params: {} });
      send({ jsonrpc: "2.0", id: CODEX_ACCOUNT_ID, method: "account/read", params: {} });
      send({ jsonrpc: "2.0", id: CODEX_RATE_LIMITS_ID, method: "account/rateLimits/read", params: {} });
      /* Left open. The server exits when stdin closes, and closing it here
         races the two answers; `until` below is what ends the process. */
    },
    (stdout) => collectCodexAnswers(stdout).answered.size === 2,
  );

  const answers = collectCodexAnswers(ran.stdout);
  if (answers.answered.size === 0) {
    throw new Error(
      ran.stderr.trim() || (ran.timedOut ? "codex app-server did not answer in time" : "codex app-server said nothing"),
    );
  }
  return answers;
}

// ---------------------------------------------------------------------------
// The public read
// ---------------------------------------------------------------------------

/** A snapshot for an agent that has no probe — a real answer, not a failure. */
const unsupported = (agentId: string, profileId: string): QuotaSnapshot => ({
  agentId,
  profileId,
  source: "agent",
  status: "unsupported",
  windows: [],
  raw: "",
  fetchedAt: Date.now(),
});

type SnapshotBase = Pick<QuotaSnapshot, "agentId" | "profileId" | "source" | "fetchedAt">;

const failed = (base: SnapshotBase, err: unknown): QuotaSnapshot => ({
  ...base,
  status: "error",
  windows: [],
  raw: "",
  error: err instanceof Error ? err.message : String(err),
});

async function runProbe(agent: AgentDef, profile: Profile, project: Project): Promise<QuotaSnapshot> {
  /* The profile's own provider first, and unconditionally: see the header. What
     the turn is billed to outranks what the runtime happens to be able to say.

     `agentId: ""` rather than the agent that asked, because the account is the
     profile's — the cache entry is shared across every agent on it, and stamping
     one runtime's id on it would make a reading two cards disagree about. */
  const usage = profileUsage(profile);
  if (usage) {
    const base: SnapshotBase = { agentId: "", profileId: profile.id, source: "profile", fetchedAt: Date.now() };
    try {
      return { ...base, ...(await readProfileUsage(profile)) };
    } catch (err) {
      return failed(base, err);
    }
  }

  const probe = agent.quotaProbe;
  if (!probe) return unsupported(agent.id, profile.id);
  const base: SnapshotBase = { agentId: agent.id, profileId: profile.id, source: "agent", fetchedAt: Date.now() };
  try {
    if (probe.kind === "codex-app-server") {
      return { ...base, ...foldCodexQuota(await probeCodex(probe, agent, profile, project)) };
    }
    const ran = await run(probe, agent, profile, project);
    if (!ran.stdout.trim()) {
      throw new Error(ran.stderr.trim() || (ran.timedOut ? `${probe.command} did not answer in time` : `${probe.command} said nothing`));
    }
    return { ...base, ...parseClaudeUsage(ran.stdout) };
  } catch (err) {
    return failed(base, err);
  }
}

/**
 * Whether this (profile, agent) pair has a plan a *thread* can be told about.
 *
 * Two readers, two ways of being true. A profile that names a usage provider
 * has one whatever runtime spends it — that is the account the turn is billed
 * to. And a thread on an agent's **virtual Default profile** has one too: a
 * Default carries no credentials, so the runtime runs on the machine's own
 * `claude`/`codex login`, and that login is exactly what the agent's probe
 * reads. The reading is the plan the turn is spending, which is the whole test.
 *
 * What stays out is the case the surfaces were originally written around: a
 * *stored* profile with no usage provider. That is a gateway or an API key,
 * metered per token, and the machine's own subscription says nothing about it —
 * so a thread on one still draws no plan card.
 */
export function planReadable(profile: Profile, agent: Pick<AgentDef, "quotaProbe">): boolean {
  return Boolean(profileUsage(profile) || (isVirtualProfile(profile.id) && agent.quotaProbe));
}

/**
 * This (profile, agent)'s quota — from cache while it is fresh, else by asking.
 *
 * Coalesced and cached for the reason `probeAgentOptions` is: asking spawns a
 * process, or at best makes a network call to a provider's dashboard API.
 * `refresh` is the escape hatch for the button that says Refresh, and for the
 * re-read after a turn settles.
 *
 * An `error` snapshot is cached too, and on purpose: a missing binary, a wedged
 * CLI or an unreachable provider would otherwise be retried by every render of
 * the page that shows the failure, which is the one situation where retrying
 * hardest helps least.
 */
export async function getQuota(
  agent: AgentDef,
  profile: Profile,
  project: Project,
  { refresh = false } = {},
): Promise<QuotaSnapshot> {
  if (!profileUsage(profile) && !agent.quotaProbe) return unsupported(agent.id, profile.id);
  /* The profile's own provider is an HTTP call against a stored key and races
     nothing, so it is never held back; only the probe, which is a process. See
     the header above `runtimeIsLive`. `refresh` does not override this — the
     Refresh button is the *worst* moment to spawn a second CLI, because it is
     pressed while watching a turn run. */
  if (await probeHeldBack(profile, agent, project)) return lastKnown(agent.id, profile.id);
  return cached(keyFor(profile, agent.id), refresh, () => runProbe(agent, profile, project));
}

/**
 * A profile's provider usage on its own, with no agent in the question.
 *
 * The settings page needs this: a z.ai plan is one account, and asking about it
 * "as Claude Code" and again "as Codex" would make two identical HTTP calls and
 * draw two cards for one number. `getQuota` shares the cache entry, so a thread
 * that asks about its own (profile, agent) pair gets the very same reading.
 * Resolves to `unsupported` for a profile that names no provider rather than
 * throwing — the caller filters, but a route must not 500 on a stale id.
 */
export function getProfileQuota(profile: Profile, { refresh = false } = {}): Promise<QuotaSnapshot> {
  if (!profileUsage(profile)) return Promise.resolve(unsupported("", profile.id));
  return cached(cacheKey(profile.id, USAGE_SUFFIX), refresh, async () => {
    const base: SnapshotBase = { agentId: "", profileId: profile.id, source: "profile", fetchedAt: Date.now() };
    try {
      return { ...base, ...(await readProfileUsage(profile)) };
    } catch (err) {
      return failed(base, err);
    }
  });
}

/** The cache and the in-flight map around whichever reader was chosen. */
async function cached(key: string, refresh: boolean, read: () => Promise<QuotaSnapshot>): Promise<QuotaSnapshot> {
  if (!refresh) {
    const hit = (await db.select().from(agentQuotaTable).where(eq(agentQuotaTable.key, key)).limit(1))[0];
    if (hit && Date.now() - hit.fetchedAt < QUOTA_TTL_MS) return Promise.resolve(hit.snapshot as QuotaSnapshot);
  }
  const running = inflight.get(key);
  if (running) return running;

  const pending = read()
    .then(async (snapshot) => {
      await db.insert(agentQuotaTable)
        .values({ key, snapshot, fetchedAt: snapshot.fetchedAt })
        .onConflictDoUpdate({ target: agentQuotaTable.key, set: { snapshot, fetchedAt: snapshot.fetchedAt } });
      return snapshot;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/**
 * Forget this thread's reading so the next read asks again. Called when a turn
 * settles: the turn is exactly what moved the number.
 *
 * Takes the profile rather than its id because only the profile knows which of
 * the two keys the reading is under — dropping `<profile>:<agent>` for a thread
 * whose number lives at `<profile>:usage` would silently pin the card at
 * whatever the plan said five minutes ago.
 */
export async function invalidateQuota(profile: Profile, agentId: string): Promise<void> {
  await db.delete(agentQuotaTable).where(eq(agentQuotaTable.key, keyFor(profile, agentId)));
}
