import { USAGE_KINDS } from "./db/index.js";
import type { ProfileUsage, ProfileUsageKind } from "./db/index.js";
import type { QuotaSnapshot, QuotaStatus, QuotaWindow } from "./protocol.js";
import type { Profile } from "./profiles.js";

/*
 * What is left of the plan a *provider* sells, read from that provider's own
 * account API.
 *
 * The sibling of quota.ts, and the distinction between them is the whole point.
 * `quota.ts` asks a runtime's CLI — `claude -p /usage`, `codex app-server` —
 * which is the right question when the subscription and the runtime are the same
 * company's, and is nonsense otherwise: a thread running Claude Code against a
 * z.ai GLM Coding Plan spends z.ai's five-hour window, while `claude`'s own
 * `/usage` reports an Anthropic account that turn never touched. The account
 * being spent belongs to the profile's credentials, so the reading does too.
 *
 * Three rules, two of them inherited from quota.ts because the snapshot is
 * shared and the client renders both the same way.
 *
 * **The adapter owns the endpoint.** `ProfileUsage` carries a `kind` and, at
 * most, a host override — never a URL to fetch, a header name or a response
 * path. A provider's usage API is undocumented and idiosyncratic (z.ai's wants
 * the key in a bare `Authorization`, with no `Bearer`, and buries the windows
 * under integer unit codes); expressing that as configuration would make the
 * profile form a small programming language, and the next provider would still
 * not fit it. An unknown `kind` therefore throws rather than falling through to
 * whichever adapter happens to be the default branch.
 *
 * **The raw body is always kept.** These endpoints are the ones a provider's own
 * dashboard calls, not ones it documents, so a field can be renamed between any
 * two Tuesdays. A shape that stops parsing has to degrade to "here is what the
 * provider said" rather than to a card claiming 0%.
 *
 * **"No plan" is an answer.** A key on pay-as-you-go metering reads `api-key`
 * and the UI says so in words. Only a call that could not be made, or a body
 * that could not be understood, is an `error`.
 */

/** Long enough for a cold monitor endpoint, short enough that a hanging provider
    does not hold the settings page open. These are single small JSON GETs. */
const USAGE_TIMEOUT_MS = 10_000;

export { USAGE_KINDS };

/** The configured provider, or null when there is none — which is the case for
    `kind: "none"`, for a profile saved before the column existed, and for every
    virtual Default (a Default carries no credentials, so there is no account to
    ask about; the agent's own probe is exactly the right reader there). */
export function profileUsage(profile: Profile): ProfileUsage | null {
  const usage = profile.usage;
  if (!usage || !usage.kind || usage.kind === "none") return null;
  return usage;
}

/** The credential the monitor call carries: the usage override when one is set,
    otherwise the profile's own key. Overriding is for a provider that issues a
    separate read-only dashboard token; the ordinary case is one coding-plan key
    that both the inference and the monitor route accept. */
const usageKey = (profile: Profile, usage: ProfileUsage): string =>
  usage.apiKey?.trim() || profile.apiKey || "";

// ---------------------------------------------------------------------------
// Adapter: Z.AI / Zhipu — GLM Coding Plan
// ---------------------------------------------------------------------------

/*
 * `GET {host}/api/monitor/usage/quota/limit`, `Authorization: <key>` with no
 * `Bearer` prefix (the endpoint rejects one), answering
 *
 *   { "data": { "level": "pro", "limits": [
 *       { "type": "TOKENS_LIMIT", "unit": 3, "number": 5,
 *         "percentage": 40.5, "nextResetTime": 1788150000000 },
 *       { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 52.0, … },
 *       { "type": "TIME_LIMIT", "percentage": 12.3, "currentValue": 123,
 *         "usage": 1000, "usageDetails": [{ "modelCode": "web-reader", … }] } ] } }
 *
 * This is the route z.ai's own Plan Overview page calls; it is not in the
 * published API docs, which is the reason `raw` matters more here than anywhere
 * else in the harness. A window is described by a (unit, number) pair rather
 * than a duration — `unit: 3, number: 5` is the rolling five hours and
 * `unit: 6, number: 1` the week — so the two known units are mapped to minutes
 * and an unrecognised one degrades to a labelled window with no duration
 * instead of being dropped or given an invented one.
 */

const ZAI_GLOBAL_HOST = "https://api.z.ai";
const ZAI_CN_HOST = "https://open.bigmodel.cn";
const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";

/** Minutes in one of z.ai's `unit` codes. Only the two the plan actually meters
    are known; anything else is left undated rather than guessed at, because a
    wrong `windowMinutes` becomes a wrong label and a wrong sort. */
const ZAI_UNIT_MINUTES: Record<number, number> = { 3: 60, 6: 7 * 24 * 60 };

interface ZaiLimit {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  currentValue?: number;
  usage?: number;
  /** Epoch *milliseconds*, unlike codex's seconds. */
  nextResetTime?: number;
  usageDetails?: unknown;
}

interface ZaiQuotaBody {
  code?: number;
  msg?: string;
  message?: string;
  data?: { level?: string; limits?: ZaiLimit[] } | null;
}

/** Where to GET. A `baseUrl` that already names the monitor route is used whole
    (someone pointing at a proxy); otherwise it is an origin the path is joined
    onto. With nothing set, the profile's own base URL picks the platform —
    a bigmodel.cn gateway is the CN account, and its key is not the global one. */
export function zaiQuotaUrl(profile: Profile, usage: ProfileUsage): string {
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  if (override) return override.includes("/monitor/") ? override : override + ZAI_QUOTA_PATH;
  const cn = /bigmodel\.cn/i.test(profile.baseUrl || "");
  return (cn ? ZAI_CN_HOST : ZAI_GLOBAL_HOST) + ZAI_QUOTA_PATH;
}

/** `300` → `Token usage (5 hour)`. Mirrors `codexWindowLabel`'s shape so the two
    providers' cards read alike, with the metric named because z.ai meters
    tokens in one window and tool calls in another. */
function zaiWindowLabel(minutes: number | null, unit?: number, number?: number): string {
  if (!minutes) return unit === undefined ? "Token usage" : `Token usage (unit ${unit}, number ${number})`;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    if (days === 7) return "Token usage (weekly)";
    return days === 1 ? "Token usage (daily)" : `Token usage (${days} day)`;
  }
  if (minutes % 60 === 0) return `Token usage (${minutes / 60} hour)`;
  return `Token usage (${minutes} min)`;
}

/** `five_hour`/`seven_day` where the window is one of those, deliberately the
    same ids Claude Code's adapter mints: they are keys, and two providers
    metering the same shape of window should agree on one. */
function zaiWindowId(minutes: number | null, unit?: number, number?: number): string {
  if (minutes === 300) return "five_hour";
  if (minutes === 7 * 24 * 60) return "seven_day";
  return `tokens_${unit ?? "x"}_${number ?? "x"}`;
}

function zaiWindow(limit: ZaiLimit): QuotaWindow | null {
  if (typeof limit.percentage !== "number") return null;
  if (limit.type === "TIME_LIMIT") {
    return {
      id: "mcp_monthly",
      label: "MCP tool usage (monthly)",
      usedPercent: limit.percentage,
      resetsAt: limit.nextResetTime ?? null,
      windowMinutes: 30 * 24 * 60,
    };
  }
  const unitMinutes = limit.unit === undefined ? undefined : ZAI_UNIT_MINUTES[limit.unit];
  const minutes = unitMinutes && limit.number ? unitMinutes * limit.number : null;
  return {
    id: zaiWindowId(minutes, limit.unit, limit.number),
    label: zaiWindowLabel(minutes, limit.unit, limit.number),
    usedPercent: limit.percentage,
    resetsAt: limit.nextResetTime ?? null,
    windowMinutes: minutes,
  };
}

/** The parse, split out from the fetch so the test can pin it against a captured
    body — the same split `parseClaudeUsage`/`foldCodexQuota` exist for. */
export function foldZaiQuota(
  body: ZaiQuotaBody,
  httpStatus = 200,
): Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName"> {
  const limits = body?.data?.limits ?? [];
  const windows = limits.map(zaiWindow).filter((w): w is QuotaWindow => w !== null);
  const message = body?.msg || body?.message || "";

  const status: QuotaStatus = windows.length
    ? "subscription"
    : httpStatus === 401 || httpStatus === 403
      ? "unauthenticated"
      : httpStatus !== 200
        ? "error"
        : /* A 200 with no windows is an account in good standing that simply has
             no coding plan — pay-as-you-go metering, which is a real answer and
             not a failure. A 200 the body itself calls an error is not. */
          body?.code !== undefined && body.code !== 0 && body.code !== 200
          ? "error"
          : "api-key";

  return {
    status,
    windows,
    raw: JSON.stringify(body, null, 2),
    planName: body?.data?.level ?? null,
  };
}

async function readZaiUsage(
  profile: Profile,
  usage: ProfileUsage,
): Promise<Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName">> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read Z.AI usage with");

  const res = await fetch(zaiQuotaUrl(profile, usage), {
    method: "GET",
    headers: {
      /* Bare, with no `Bearer` — the monitor route rejects the prefixed form.
         Not a quirk worth abstracting: it is this adapter's business. */
      Authorization: key,
      Accept: "application/json",
      "Accept-Language": "en-US,en",
    },
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  });

  const text = await res.text();
  let body: ZaiQuotaBody;
  try {
    body = JSON.parse(text) as ZaiQuotaBody;
  } catch {
    /* Not JSON at all — an HTML login page or a proxy error. There is nothing to
       fold, and the body is what explains it. */
    throw new Error(`Z.AI usage returned ${res.status} ${res.statusText}: ${text.slice(0, 300).trim() || "(empty)"}`);
  }
  return foldZaiQuota(body, res.status);
}

// ---------------------------------------------------------------------------
// Shared: one JSON GET, with the body kept whatever it is
// ---------------------------------------------------------------------------

type Fold = Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName" | "credits">;

/** GET/POST a provider's JSON, or throw with the body — the way `readZaiUsage`
    does: a non-JSON answer (a login page, a proxy error) is not something to
    fold, and its first lines are what explain it. */
async function fetchJson<T>(
  url: string,
  init: RequestInit,
  who: string,
): Promise<{ body: T; status: number }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(USAGE_TIMEOUT_MS) });
  const text = await res.text();
  try {
    return { body: JSON.parse(text) as T, status: res.status };
  } catch {
    throw new Error(`${who} usage returned ${res.status} ${res.statusText}: ${text.slice(0, 300).trim() || "(empty)"}`);
  }
}

/** A finite number out of a number or a numeric string, else null. Several of
    these APIs (Kimi, DeepSeek) serialize counts and money as strings. */
const num = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Epoch ms out of epoch seconds, epoch ms, or an ISO string, else null. */
const when = (value: unknown): number | null => {
  const n = num(value);
  if (n !== null) return n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

const pct = (used: number, limit: number): number => Math.max(0, Math.min(100, (used / limit) * 100));

/** `300` → `5 hour`, `10080` → `weekly`, for the labels below. */
function spanLabel(minutes: number | null): string | null {
  if (!minutes) return null;
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 7 ? "weekly" : days === 1 ? "daily" : days === 30 ? "monthly" : `${days} day`;
  }
  if (minutes % 60 === 0) return `${minutes / 60} hour`;
  return `${minutes} min`;
}

/** The same ids Claude Code's and z.ai's adapters mint for the same windows. */
function spanId(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "five_hour";
  if (minutes === 7 * 24 * 60) return "seven_day";
  return fallback;
}

/** `unauthenticated` for a rejected key, `error` for any other non-200 — the
    split every adapter below makes after its own body-level checks. */
const httpStatus = (status: number): QuotaStatus | null =>
  status === 401 || status === 403 ? "unauthenticated" : status !== 200 ? "error" : null;

// ---------------------------------------------------------------------------
// Adapter: MiniMax — Coding Plan
// ---------------------------------------------------------------------------

/*
 * `GET {host}/v1/token_plan/remains`, `Authorization: Bearer <key>`, answering
 * (verified against api.minimax.io; the key is the plan's own)
 *
 *   { "base_resp": { "status_code": 0, "status_msg": "success" },
 *     "data"?: { "plan_name": "...", "current_subscribe_title": "...",
 *       "model_remains": [ { "model_name": "MiniMax-M3",
 *         "current_interval_total_count": 1500, "current_interval_usage_count": 120,
 *         "start_time": 1788150000000, "end_time": 1788168000000,
 *         "current_interval_remaining_percent": 92,
 *         "current_weekly_total_count": 10000, "current_weekly_usage_count": 400,
 *         "weekly_end_time": 1788500000000, "current_weekly_remaining_percent": 96 } ] } }
 *
 * The plan's own dashboard calls this; an older `coding_plan/remains` route
 * exists too and wants a cookie. `data` is sometimes absent with the fields at
 * the root, so both are read. Every model gets its own 5-hour and weekly
 * counters, and the plan is one pool — the model with the most used is the
 * plan's reading, and the rest ride along in `raw`. An HTTP 200 whose
 * `base_resp.status_code` is not 0 is the provider saying no, and 1004 is
 * specifically "bad credentials".
 */

const MINIMAX_GLOBAL_HOST = "https://api.minimax.io";
const MINIMAX_CN_HOST = "https://api.minimaxi.com";
const MINIMAX_REMAINS_PATH = "/v1/token_plan/remains";

interface MinimaxRemain {
  model_name?: string;
  current_interval_total_count?: number;
  current_interval_usage_count?: number;
  start_time?: number;
  end_time?: number;
  current_interval_remaining_percent?: number;
  current_weekly_total_count?: number;
  current_weekly_usage_count?: number;
  weekly_end_time?: number;
  current_weekly_remaining_percent?: number;
}

interface MinimaxData {
  plan_name?: string;
  current_subscribe_title?: string;
  current_plan_title?: string;
  model_remains?: MinimaxRemain[];
}

interface MinimaxBody extends MinimaxData {
  base_resp?: { status_code?: number; status_msg?: string };
  data?: MinimaxData | null;
}

export function minimaxQuotaUrl(profile: Profile, usage: ProfileUsage): string {
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  if (override) return override.includes("/remains") ? override : override + MINIMAX_REMAINS_PATH;
  const cn = /minimaxi\.com/i.test(profile.baseUrl || "");
  return (cn ? MINIMAX_CN_HOST : MINIMAX_GLOBAL_HOST) + MINIMAX_REMAINS_PATH;
}

/** Percent used from a (total, usage) pair, falling back to the provider's own
    `remaining_percent`. A total of zero is a counter the plan does not meter. */
function minimaxUsed(total?: number, usage?: number, remainingPercent?: number): number | null {
  if (typeof total === "number" && total > 0 && typeof usage === "number") return pct(usage, total);
  if (typeof remainingPercent === "number") return Math.max(0, Math.min(100, 100 - remainingPercent));
  return null;
}

export function foldMinimaxQuota(body: MinimaxBody, status = 200): Fold {
  const raw = JSON.stringify(body, null, 2);
  const data: MinimaxData = body?.data ?? body ?? {};
  const code = body?.base_resp?.status_code;
  const remains = data.model_remains ?? [];

  /* One window per pool, the fullest model's. Ties go to the first listed,
     which is the plan's headline model. */
  let interval: { used: number; model: string; resetsAt: number | null; minutes: number | null } | null = null;
  let weekly: { used: number; model: string; resetsAt: number | null } | null = null;
  for (const r of remains) {
    const model = r.model_name ?? "model";
    const iu = minimaxUsed(r.current_interval_total_count, r.current_interval_usage_count, r.current_interval_remaining_percent);
    if (iu !== null && (!interval || iu > interval.used)) {
      const minutes =
        typeof r.start_time === "number" && typeof r.end_time === "number" && r.end_time > r.start_time
          ? Math.round((r.end_time - r.start_time) / 60_000)
          : null;
      interval = { used: iu, model, resetsAt: when(r.end_time), minutes };
    }
    const wu = minimaxUsed(r.current_weekly_total_count, r.current_weekly_usage_count, r.current_weekly_remaining_percent);
    if (wu !== null && (!weekly || wu > weekly.used)) weekly = { used: wu, model, resetsAt: when(r.weekly_end_time) };
  }

  const windows: QuotaWindow[] = [];
  if (interval) {
    const span = spanLabel(interval.minutes) ?? "5 hour";
    windows.push({
      id: spanId(interval.minutes ?? 300, "interval"),
      label: `Requests (${span}) · ${interval.model}`,
      usedPercent: interval.used,
      resetsAt: interval.resetsAt,
      windowMinutes: interval.minutes ?? 300,
    });
  }
  if (weekly) {
    windows.push({
      id: "seven_day",
      label: `Requests (weekly) · ${weekly.model}`,
      usedPercent: weekly.used,
      resetsAt: weekly.resetsAt,
      windowMinutes: 7 * 24 * 60,
    });
  }

  const quotaStatus: QuotaStatus = windows.length
    ? "subscription"
    : code === 1004
      ? "unauthenticated"
      : (httpStatus(status) ?? (code !== undefined && code !== 0 ? "error" : "api-key"));

  return {
    status: quotaStatus,
    windows,
    raw,
    planName: data.plan_name || data.current_subscribe_title || data.current_plan_title || null,
  };
}

async function readMinimaxUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read MiniMax usage with");
  const { body, status } = await fetchJson<MinimaxBody>(
    minimaxQuotaUrl(profile, usage),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "MM-API-Source": "daedalus" },
    },
    "MiniMax",
  );
  return foldMinimaxQuota(body, status);
}

// ---------------------------------------------------------------------------
// Adapter: Moonshot — Kimi For Coding
// ---------------------------------------------------------------------------

/*
 * `GET {host}/coding/v1/usages`, `Authorization: Bearer <key>`, answering
 * (verified against api.kimi.com, which 401s a bad key with a `code`)
 *
 *   { "usage":  { "limit": "2000", "used": "312", "remaining": "1688",
 *                 "resetTime": "2026-09-08T00:00:00Z" },
 *     "limits": [ { "window": { "duration": 5, "timeUnit": "TIME_UNIT_HOUR" },
 *                   "detail": { "limit": "200", "used": "17", "remaining": "183",
 *                               "resetTime": "2026-09-02T15:00:00Z" } } ] }
 *
 * `usage` is the weekly allowance and each `limits[]` entry a shorter rolling
 * window; counts are strings. The host is the plan's own API host, so the
 * usage URL is derived from the profile's base URL when that already names
 * `/coding`, and defaults to api.kimi.com otherwise.
 */

const KIMI_HOST = "https://api.kimi.com";
const KIMI_USAGES_PATH = "/coding/v1/usages";

interface KimiDetail {
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
  reset_time?: unknown;
}

interface KimiBody {
  code?: string;
  usage?: KimiDetail;
  limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiDetail }[];
}

const KIMI_UNIT_MINUTES: Record<string, number> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 24 * 60,
};

export function kimiQuotaUrl(profile: Profile, usage: ProfileUsage): string {
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  if (override) return override.endsWith("/usages") ? override : override.replace(/\/coding(\/v1)?$/, "") + KIMI_USAGES_PATH;
  const base = (profile.baseUrl || "").trim().replace(/\/+$/, "");
  const m = /^(https?:\/\/[^/]+)\/coding(\/v1)?$/i.exec(base);
  return (m ? m[1] : KIMI_HOST) + KIMI_USAGES_PATH;
}

function kimiWindow(detail: KimiDetail | undefined, id: string, minutes: number | null, label: string): QuotaWindow | null {
  const limit = num(detail?.limit);
  const used = num(detail?.used);
  const remaining = num(detail?.remaining);
  if (!limit || limit <= 0) return null;
  const spent = used ?? (remaining !== null ? limit - remaining : null);
  if (spent === null) return null;
  return { id, label, usedPercent: pct(spent, limit), resetsAt: when(detail?.resetTime ?? detail?.reset_time), windowMinutes: minutes };
}

export function foldKimiQuota(body: KimiBody, status = 200): Fold {
  const windows: QuotaWindow[] = [];
  for (const [i, entry] of (body?.limits ?? []).entries()) {
    const unit = entry.window?.timeUnit ? KIMI_UNIT_MINUTES[entry.window.timeUnit] : undefined;
    const minutes = unit && entry.window?.duration ? unit * entry.window.duration : null;
    const w = kimiWindow(entry.detail, spanId(minutes, `limit_${i}`), minutes, `Requests (${spanLabel(minutes) ?? "rolling"})`);
    if (w) windows.push(w);
  }
  const weekly = kimiWindow(body?.usage, "seven_day", 7 * 24 * 60, "Requests (weekly)");
  if (weekly && !windows.some((w) => w.id === "seven_day")) windows.push(weekly);

  const quotaStatus: QuotaStatus = windows.length
    ? "subscription"
    : body?.code === "unauthenticated"
      ? "unauthenticated"
      : (httpStatus(status) ?? (body?.code ? "error" : "api-key"));
  return { status: quotaStatus, windows, raw: JSON.stringify(body, null, 2), planName: null };
}

async function readKimiUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read Kimi usage with");
  const { body, status } = await fetchJson<KimiBody>(
    kimiQuotaUrl(profile, usage),
    { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    "Kimi",
  );
  return foldKimiQuota(body, status);
}

// ---------------------------------------------------------------------------
// Adapter: Synthetic
// ---------------------------------------------------------------------------

/*
 * `GET https://api.synthetic.new/v2/quotas`, `Authorization: Bearer <key>`
 * (a bad key answers `401 {"error":"Invalid API Key."}`), answering one object
 * per pool:
 *
 *   { "subscription": { "limit": 135, "requests": 12, "renewsAt": "2026-09-02T15:00:00Z" },
 *     "search":       { "limit": 100, "requests": 3,  "renewsAt": "…" } }
 *
 * The pools are named by key, not typed, and the harness reads any top-level
 * object carrying a `limit` beside a `requests`/`used` count. The two known
 * keys get their durations (the plan's rolling five hours and the hourly
 * search allowance); anything else is a labelled window with no duration.
 */

const SYNTHETIC_QUOTAS_URL = "https://api.synthetic.new/v2/quotas";

interface SyntheticPool {
  limit?: unknown;
  requests?: unknown;
  used?: unknown;
  remaining?: unknown;
  renewsAt?: unknown;
  resetsAt?: unknown;
  plan?: unknown;
}

const SYNTHETIC_POOLS: Record<string, { label: string; minutes: number; id: string }> = {
  subscription: { label: "Requests (5 hour)", minutes: 300, id: "five_hour" },
  search: { label: "Search (hourly)", minutes: 60, id: "search_hourly" },
};

export function foldSyntheticQuota(body: Record<string, unknown>, status = 200): Fold {
  const windows: QuotaWindow[] = [];
  let planName: string | null = null;
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const pool = value as SyntheticPool;
    const limit = num(pool.limit);
    const used = num(pool.requests) ?? num(pool.used);
    const remaining = num(pool.remaining);
    if (typeof pool.plan === "string") planName = pool.plan;
    if (!limit || limit <= 0) continue;
    const spent = used ?? (remaining !== null ? limit - remaining : null);
    if (spent === null) continue;
    const known = SYNTHETIC_POOLS[key];
    windows.push({
      id: known?.id ?? key,
      label: known?.label ?? `${key[0].toUpperCase()}${key.slice(1)}`,
      usedPercent: pct(spent, limit),
      resetsAt: when(pool.renewsAt ?? pool.resetsAt),
      windowMinutes: known?.minutes ?? null,
    });
  }
  const quotaStatus: QuotaStatus = windows.length ? "subscription" : (httpStatus(status) ?? (body?.error ? "error" : "api-key"));
  return { status: quotaStatus, windows, raw: JSON.stringify(body, null, 2), planName };
}

async function readSyntheticUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read Synthetic usage with");
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  const url = override ? (override.endsWith("/quotas") ? override : override + "/v2/quotas") : SYNTHETIC_QUOTAS_URL;
  const { body, status } = await fetchJson<Record<string, unknown>>(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    "Synthetic",
  );
  return foldSyntheticQuota(body, status);
}

// ---------------------------------------------------------------------------
// Adapter: DeepSeek — account balance
// ---------------------------------------------------------------------------

/*
 * `GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>` —
 * the one documented route in this file (api-docs.deepseek.com › Get User
 * Balance), answering
 *
 *   { "is_available": true,
 *     "balance_infos": [ { "currency": "USD", "total_balance": "12.34",
 *                          "granted_balance": "0.00", "topped_up_balance": "12.34" } ] }
 *
 * No windows: DeepSeek is metered per token, so the reading is `credits` on an
 * `api-key` status, which the card draws as a balance line. `is_available:
 * false` is a zero balance — still an answer.
 */

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

interface DeepseekBody {
  is_available?: boolean;
  balance_infos?: { currency?: string; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown }[];
  error?: { message?: string };
}

export function foldDeepseekQuota(body: DeepseekBody, status = 200): Fold {
  const raw = JSON.stringify(body, null, 2);
  const infos = body?.balance_infos ?? [];
  if (!infos.length) {
    return { status: httpStatus(status) ?? (body?.error ? "error" : "api-key"), windows: [], raw, planName: null, credits: null };
  }
  const balance = infos
    .map((b) => {
      const total = num(b.total_balance);
      return total === null ? null : `${total.toFixed(2)} ${b.currency ?? ""}`.trim();
    })
    .filter((s): s is string => s !== null)
    .join(" · ");
  return { status: "api-key", windows: [], raw, planName: null, credits: { balance: balance || null, unlimited: false } };
}

async function readDeepseekUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read DeepSeek usage with");
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  const url = override ? (override.endsWith("/balance") ? override : override + "/user/balance") : DEEPSEEK_BALANCE_URL;
  const { body, status } = await fetchJson<DeepseekBody>(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    "DeepSeek",
  );
  return foldDeepseekQuota(body, status);
}

// ---------------------------------------------------------------------------
// Adapter: OpenRouter — key limit and credits
// ---------------------------------------------------------------------------

/*
 * Two documented routes (openrouter.ai/docs/api-reference), both
 * `Authorization: Bearer <key>`:
 *
 *   GET /api/v1/key      → { "data": { "label": "…", "usage": 1.23, "limit": 10,
 *                             "limit_remaining": 8.77, "limit_reset": "monthly",
 *                             "is_free_tier": false, "usage_daily": 0.1, … } }
 *   GET /api/v1/credits  → { "data": { "total_credits": 50, "total_usage": 31.2 } }
 *
 * A key with a `limit` is a window (the key's own cap, in dollars, over
 * whatever `limit_reset` names); a key without one has nothing to draw but the
 * account's credits. `/credits` needs a key with management scope on some
 * accounts, so its failure is folded in as "no credits line" rather than as
 * the reading's failure.
 */

const OPENROUTER_API = "https://openrouter.ai/api/v1";

interface OpenrouterKey {
  label?: string;
  usage?: unknown;
  limit?: unknown;
  limit_remaining?: unknown;
  limit_reset?: string | null;
  is_free_tier?: boolean;
}

interface OpenrouterKeyBody {
  data?: OpenrouterKey;
  error?: { message?: string; code?: number };
}

interface OpenrouterCreditsBody {
  data?: { total_credits?: unknown; total_usage?: unknown };
}

const OPENROUTER_RESET_MINUTES: Record<string, number> = {
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
};

export function foldOpenrouterQuota(key: OpenrouterKeyBody, credits: OpenrouterCreditsBody | null, status = 200): Fold {
  const raw = JSON.stringify({ key, credits }, null, 2);
  const data = key?.data;
  if (!data) {
    return { status: httpStatus(status) ?? "error", windows: [], raw, planName: null, credits: null };
  }
  const windows: QuotaWindow[] = [];
  const limit = num(data.limit);
  if (limit && limit > 0) {
    const remaining = num(data.limit_remaining);
    const spent = remaining !== null ? limit - Math.max(0, Math.min(limit, remaining)) : (num(data.usage) ?? 0);
    const reset = data.limit_reset?.trim().toLowerCase() || null;
    windows.push({
      id: reset ? `key_${reset}` : "key_limit",
      label: reset ? `Key spend (${reset}) · $${limit}` : `Key spend · $${limit}`,
      usedPercent: pct(spent, limit),
      windowMinutes: reset ? (OPENROUTER_RESET_MINUTES[reset] ?? null) : null,
    });
  }
  const total = num(credits?.data?.total_credits);
  const used = num(credits?.data?.total_usage);
  const balance = total !== null && used !== null ? `$${(total - used).toFixed(2)} of $${total.toFixed(2)}` : null;
  return {
    status: windows.length ? "subscription" : "api-key",
    windows,
    raw,
    planName: data.is_free_tier ? "free" : null,
    credits: balance ? { balance, unlimited: false } : null,
  };
}

async function readOpenrouterUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read OpenRouter usage with");
  const base = usage.baseUrl?.trim().replace(/\/+$/, "") || OPENROUTER_API;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const keyRes = await fetchJson<OpenrouterKeyBody>(`${base}/key`, { method: "GET", headers }, "OpenRouter");
  let credits: OpenrouterCreditsBody | null = null;
  try {
    const res = await fetchJson<OpenrouterCreditsBody>(`${base}/credits`, { method: "GET", headers }, "OpenRouter");
    if (res.status === 200) credits = res.body;
  } catch {
    /* The balance is an extra; the key reading stands without it. */
  }
  return foldOpenrouterQuota(keyRes.body, credits, keyRes.status);
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

/**
 * Read this profile's provider usage. Throws when there is no provider, when
 * the call fails, or when the answer is unreadable — `quota.ts` turns any of
 * those into an `error` snapshot, the same way it does for a probe.
 */
export function readProfileUsage(profile: Profile): Promise<Fold> {
  const usage = profileUsage(profile);
  if (!usage) return Promise.reject(new Error("this profile names no usage provider"));
  switch (usage.kind) {
    case "zai":
      return readZaiUsage(profile, usage);
    case "minimax":
      return readMinimaxUsage(profile, usage);
    case "kimi":
      return readKimiUsage(profile, usage);
    case "synthetic":
      return readSyntheticUsage(profile, usage);
    case "deepseek":
      return readDeepseekUsage(profile, usage);
    case "openrouter":
      return readOpenrouterUsage(profile, usage);
    default:
      /* Deliberately not a fall-through to some default adapter: a `kind` this
         build does not know is a profile written by a newer one, and answering
         it with the wrong provider's parser invents numbers. */
      return Promise.reject(new Error(`unknown usage provider: ${usage.kind}`));
  }
}

export type { ProfileUsage, ProfileUsageKind };
