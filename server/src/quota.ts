import { spawn } from "node:child_process";
import { eq, like } from "drizzle-orm";
import { agentQuota as agentQuotaTable, db, type QuotaProbe } from "./db/index.js";
import { resolveSpawn, type AgentDef } from "./registry.js";
import { profileUsage, readProfileUsage } from "./usage-api.js";
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from "./protocol.js";
import type { Profile } from "./profiles.js";
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
    does not hold a settings page open. `claude -p /usage` measures ~2.3s. */
const PROBE_TIMEOUT_MS = 30_000;

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
      /* Killed, not asked politely: the answers are in hand, and `close` will
         still fire and settle this with everything collected. */
      if (until?.(stdout)) {
        child.kill("SIGKILL");
        finish(0);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
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
export function parseClaudeUsage(stdout: string): Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName"> {
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
  const status: QuotaStatus = windows.length
    ? "subscription"
    : /subscription/i.test(text)
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
export function getQuota(
  agent: AgentDef,
  profile: Profile,
  project: Project,
  { refresh = false } = {},
): Promise<QuotaSnapshot> {
  if (!profileUsage(profile) && !agent.quotaProbe) {
    return Promise.resolve(unsupported(agent.id, profile.id));
  }
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
function cached(key: string, refresh: boolean, read: () => Promise<QuotaSnapshot>): Promise<QuotaSnapshot> {
  if (!refresh) {
    const hit = db.select().from(agentQuotaTable).where(eq(agentQuotaTable.key, key)).get();
    if (hit && Date.now() - hit.fetchedAt < QUOTA_TTL_MS) return Promise.resolve(hit.snapshot as QuotaSnapshot);
  }
  const running = inflight.get(key);
  if (running) return running;

  const pending = read()
    .then((snapshot) => {
      db.insert(agentQuotaTable)
        .values({ key, snapshot, fetchedAt: snapshot.fetchedAt })
        .onConflictDoUpdate({ target: agentQuotaTable.key, set: { snapshot, fetchedAt: snapshot.fetchedAt } })
        .run();
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
export function invalidateQuota(profile: Profile, agentId: string): void {
  db.delete(agentQuotaTable).where(eq(agentQuotaTable.key, keyFor(profile, agentId))).run();
}

/** Drop every reading taken under this profile. For an edit to the profile
    itself: a new key, a new provider or a switched-off one all make the cached
    number an answer about something else. */
export function invalidateProfileQuota(profileId: string): void {
  db.delete(agentQuotaTable).where(like(agentQuotaTable.key, `${profileId}:%`)).run();
}
