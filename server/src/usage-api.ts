import { USAGE_KINDS } from "./db/index.js";
import type { ProfileUsage, ProfileUsageKind } from "./db/index.js";
import type { QuotaSnapshot, QuotaStatus, QuotaWindow, QuotaAccount } from "./protocol.js";
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
      /* `usage` is the cap here and `currentValue` what has been spent of it —
         the one z.ai window that gives amounts at all; the token windows are a
         percentage and nothing else. */
      used: limit.currentValue ?? null,
      cap: limit.usage ?? null,
      unit: "calls",
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

type Fold = Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName" | "credits" | "accounts">;

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
// Adapter: Command Code — plan credits and the two rolling windows
// ---------------------------------------------------------------------------

/*
 * `GET https://api.commandcode.ai/alpha/billing/credits`, `x-api-key: <key>` —
 * the route Command Code's own `/usage` panel calls, answering
 *
 *   { "credits": { "monthlyCredits": 9.515, "purchasedCredits": 0, "freeCredits": 0 },
 *     "windowLimits": { "limited": true,
 *       "fiveHour": { "used": 0.276, "cap": 3, "exceeded": false, "resetAt": 1789180183530 },
 *       "weekly":   { "used": 0.485, "cap": 6, "exceeded": false, "resetAt": 1789657648583 } } }
 *
 * A key that is not the account's answers
 * `401 {success:false, error:{code:"UNAUTHORIZED", message:"Invalid 'Authorization' header or token."}}`.
 *
 * This is the one provider here whose route a *runtime's own login* also knows:
 * unlike `claude -p /usage`, Command Code has no non-interactive form of
 * `/usage` — the slash command exists only inside its interactive panel, and its
 * print mode sends the string to the model like any other prompt. So the account
 * API is the only reader there is, which is why this exists as a profile
 * provider rather than as an agent probe (`quota.ts`).
 *
 * The amounts are credits, not money — on most plans one credit is $1 of usage
 * and on GOAT and Pro it is a usage-value unit — so `used`/`cap` are only ever
 * turned into a percentage and the balance is labelled in credits.
 *
 * The inference side of the same account is a separate thing and not this
 * adapter's business: `/provider/v1/chat/completions` and `/provider/v1/messages`
 * for a profile's base URL, with the same key.
 */

const COMMAND_CODE_API = "https://api.commandcode.ai";
/** The CLI's own staging twin, picked the way z.ai's CN platform is: the profile
    says which platform its key belongs to, and a key minted on one is not the
    other's. */
const COMMAND_CODE_STAGING_API = "https://staging-api.commandcode.ai";
const COMMAND_CODE_CREDITS_PATH = "/alpha/billing/credits";
const COMMAND_CODE_SUBSCRIPTION_PATH = "/alpha/billing/subscriptions";

/*
 * What a plan is called and what it gives per month.
 *
 * A table, because the API does not serve one: `/alpha/billing/credits` says
 * how many credits are *left* and `/alpha/billing/subscriptions` names the
 * plan, and neither says what the plan started the month with — the CLI's own
 * `/usage` panel carries this same map and computes the bar from it. So the
 * monthly reading is only as current as this table: a plan Command Code adds,
 * or a price it changes, is a line here.
 *
 * ponytail: a hardcoded map, kept because the only alternative is no monthly
 * window at all. If the account API ever serves the allowance, read it instead
 * and let this be the fallback.
 */
const COMMAND_CODE_PLANS: Record<string, { name: string; monthlyCredits: number }> = {
  "individual-go": { name: "Go", monthlyCredits: 10 },
  "individual-goat": { name: "GOAT", monthlyCredits: 70 },
  "individual-pro": { name: "Pro", monthlyCredits: 30 },
  "individual-pro-v1": { name: "Pro", monthlyCredits: 80 },
  "individual-provider": { name: "Provider", monthlyCredits: 15 },
  "individual-max": { name: "Max", monthlyCredits: 150 },
  "individual-ultra": { name: "Ultra", monthlyCredits: 300 },
  "teams-pro": { name: "Teams Pro", monthlyCredits: 40 },
};

/** The subscription statuses that mean the plan is still giving credits. A
    canceled or unpaid one still names a `planId`, and drawing its monthly bar
    would be a plan the account no longer has. */
const COMMAND_CODE_LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Longest prefix wins, so `individual-pro-v1` is not read as `individual-pro`
    — two different allowances behind names that share one. Underscores and case
    are normalized the way the CLI normalizes them. */
function commandCodePlan(planId: unknown): { id: string; name: string; monthlyCredits: number } | null {
  if (typeof planId !== "string" || !planId.trim()) return null;
  const id = planId.trim().toLowerCase().replace(/_/g, "-");
  const match = Object.keys(COMMAND_CODE_PLANS)
    .sort((a, b) => b.length - a.length)
    .find((known) => id.startsWith(known));
  return match ? { id, ...COMMAND_CODE_PLANS[match]! } : null;
}

/** One of the two rolling windows. `used`/`cap` are credits; `resetAt` is epoch
    milliseconds, unlike codex's seconds (and `when` reads both). */
interface CommandCodeWindow {
  used?: unknown;
  cap?: unknown;
  exceeded?: unknown;
  resetAt?: unknown;
}

interface CommandCodeCreditsBody {
  success?: boolean;
  credits?: {
    /** What is **left** of this month's plan pot, not what has been spent. */
    monthlyCredits?: unknown;
    purchasedCredits?: unknown;
    freeCredits?: unknown;
    belowThreshold?: unknown;
    /** The plan this key is on. Already here, which is why naming the plan
        costs no second call — the subscription route is asked only for the
        status and the renewal date. */
    planId?: unknown;
  } | null;
  windowLimits?: {
    limited?: boolean;
    exceeded?: unknown;
    fiveHour?: CommandCodeWindow | null;
    weekly?: CommandCodeWindow | null;
  } | null;
  error?: { code?: string; status?: number; message?: string } | null;
}

/** `GET /alpha/billing/subscriptions`, the second and optional call: the plan's
    `status` (is it still giving credits) and `currentPeriodEnd` (when the
    monthly pot refills, an ISO string — `when` reads those too). */
interface CommandCodeSubscriptionBody {
  data?: {
    planId?: unknown;
    status?: unknown;
    currentPeriodStart?: unknown;
    currentPeriodEnd?: unknown;
  } | null;
}

/** Where to GET. A `baseUrl` that already names the route is used whole (someone
    pointing at a proxy); otherwise it is an origin the path is joined onto. With
    nothing set, the profile's own base URL picks the platform — the CLI reads
    the same hint out of its environment. */
export function commandCodeQuotaUrl(profile: Profile, usage: ProfileUsage): string {
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  if (override) return override.includes("/alpha/") ? override : override + COMMAND_CODE_CREDITS_PATH;
  const staging = /staging/i.test(profile.baseUrl || "");
  return (staging ? COMMAND_CODE_STAGING_API : COMMAND_CODE_API) + COMMAND_CODE_CREDITS_PATH;
}

/** A window with no cap is dropped rather than read as 0% — that number would be
    invented, which is the one thing keeping `raw` exists to avoid. */
function commandCodeWindow(
  id: string,
  label: string,
  window: CommandCodeWindow | null | undefined,
  windowMinutes: number,
): QuotaWindow | null {
  const used = num(window?.used);
  const cap = num(window?.cap);
  if (used === null || cap === null || cap <= 0) return null;
  return { id, label, usedPercent: pct(used, cap), used, cap, unit: "credits", resetsAt: when(window?.resetAt), windowMinutes };
}

/** The plan's monthly pot as a window, from what is *left* of it and what the
    plan gives — the one reading here that is not in the response, and the shape
    the CLI's own panel draws. Nothing when the plan is unknown to the table or
    the subscription says it is no longer live; a plan whose remaining credits
    exceed its allowance (a mid-month upgrade) widens the cap rather than
    reporting a negative spend, which is what the CLI does too. */
function commandCodeMonthly(
  plan: { name: string; monthlyCredits: number } | null,
  remaining: number | null,
  subscription: CommandCodeSubscriptionBody | null,
): QuotaWindow | null {
  if (!plan || remaining === null) return null;
  const status = subscription?.data?.status;
  if (typeof status === "string" && !COMMAND_CODE_LIVE_STATUSES.has(status.toLowerCase())) return null;
  const cap = Math.max(plan.monthlyCredits, remaining);
  if (cap <= 0) return null;
  return {
    id: "monthly",
    label: `Plan credits (monthly) · ${plan.name}`,
    usedPercent: pct(cap - remaining, cap),
    used: cap - remaining,
    cap,
    unit: "credits",
    resetsAt: when(subscription?.data?.currentPeriodEnd),
    windowMinutes: 30 * 24 * 60,
  };
}

export function foldCommandCodeQuota(
  body: CommandCodeCreditsBody,
  status = 200,
  subscription: CommandCodeSubscriptionBody | null = null,
): Fold {
  const limits = body?.windowLimits;
  const plan = commandCodePlan(body?.credits?.planId ?? subscription?.data?.planId);
  /* The ids Claude Code's and z.ai's adapters mint for the same shapes of
     window. The labels are Command Code's own, as its panel prints them. The
     monthly pot goes last: it is the slowest window, and the two rolling ones
     are what pace a session. */
  const windows = [
    commandCodeWindow("five_hour", "5-hour", limits?.fiveHour, 300),
    commandCodeWindow("seven_day", "Weekly", limits?.weekly, 7 * 24 * 60),
    commandCodeMonthly(plan, num(body?.credits?.monthlyCredits), subscription),
  ].filter((w): w is QuotaWindow => w !== null);

  const quotaStatus: QuotaStatus =
    windows.length
      ? "subscription"
      : /* A 200 the endpoint itself calls `limited: false` is the pay-as-you-go
           account: no subscription, so no windows to pace — "no plan" in words
           rather than a card claiming 0%, the same answer an account with no
           coding plan gets from every other adapter here. A 200 that still
           claims a limit, with nothing readable under it, is a shape that has
           moved and is an error. */
        (httpStatus(status) ?? (limits?.limited === false ? "api-key" : "error"));

  const monthly = num(body?.credits?.monthlyCredits);
  const purchased = num(body?.credits?.purchasedCredits) ?? 0;
  const free = num(body?.credits?.freeCredits) ?? 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  /* The three pots spend as one balance, so the total is the number; the parts
     are only said when there is more than one of them to say. */
  const parts = [
    ["plan", monthly ?? 0],
    ["purchased", purchased],
    ["free", free],
  ].filter(([, n]) => (n as number) > 0) as [string, number][];
  const balance =
    monthly === null
      ? null
      : `${round((monthly ?? 0) + purchased + free)} credits` +
        (parts.length > 1 ? ` (${parts.map(([k, n]) => `${round(n)} ${k}`).join(", ")})` : "");
  return {
    status: quotaStatus,
    windows,
    /* Both calls, named — the OpenRouter adapter's envelope, for the same
       reason: two undocumented routes went into this reading and a shape that
       moved has to be visible as itself. */
    raw: JSON.stringify({ credits: body, subscription }, null, 2),
    planName: plan?.name ?? null,
    credits: balance === null ? null : { balance, unlimited: false },
  };
}

async function readCommandCodeUsage(profile: Profile, usage: ProfileUsage): Promise<Fold> {
  const key = usageKey(profile, usage);
  if (!key) throw new Error("this profile has no API key to read Command Code usage with");
  /* `x-api-key`, not `Authorization` — the same header the CLI sends. */
  const headers = { "x-api-key": key, Accept: "application/json" };
  const creditsUrl = commandCodeQuotaUrl(profile, usage);
  const { body, status } = await fetchJson<CommandCodeCreditsBody>(
    creditsUrl,
    { method: "GET", headers },
    "Command Code",
  );
  /* The subscription is an extra, like OpenRouter's balance: it only sharpens
     the monthly window (is the plan live, when does the pot refill), and the
     plan's own name already rode in on the credits body. A failure here leaves
     the reading exactly as it was before this call existed. */
  let subscription: CommandCodeSubscriptionBody | null = null;
  /* Only where the credits URL is the credits route: an override pointing at
     some other path is a proxy whose sibling route we cannot name, and asking
     the same URL twice would fold a credits body in as a subscription. */
  try {
    if (!creditsUrl.endsWith(COMMAND_CODE_CREDITS_PATH)) throw new Error("no subscription route to ask");
    const res = await fetchJson<CommandCodeSubscriptionBody>(
      creditsUrl.slice(0, -COMMAND_CODE_CREDITS_PATH.length) + COMMAND_CODE_SUBSCRIPTION_PATH,
      { method: "GET", headers },
      "Command Code",
    );
    if (res.status === 200) subscription = res.body;
  } catch {
    /* Kept quiet on purpose — `raw` shows it as null. */
  }
  return foldCommandCodeQuota(body, status, subscription);
}

// ---------------------------------------------------------------------------
// Adapter: 9Router — the local gateway's own quota tracker
// ---------------------------------------------------------------------------

/*
 * 9Router (github.com/tungbach12/9router) is a self-hosted proxy: one
 * OpenAI-compatible endpoint in front of many *accounts* — a Claude
 * subscription, a Codex login, a GLM key, a free tier — with fallback between
 * them as each runs out. So the question the other adapters ask ("what is left
 * of this plan") has no single answer here, and the shape of the answer is the
 * design decision this adapter turns on.
 *
 * **Every account is its own plan, and the reading says so.** A window carries
 * `QuotaWindow.group` — the account it belongs to — and the page draws a
 * section per account, each reading the way a z.ai or a Kimi card reads: a
 * name, and that account's own bars under it. Nothing is pooled and nothing is
 * averaged. Pooling was tried first, on the theory that fallback makes the
 * gateway's aggregate headroom the only number that gates a turn, and it is
 * wrong for the thing a person actually does with this page: a five-hour
 * window is a *different* five hours per account, a Max subscription and a GLM
 * key are not interchangeable capacity, and "60% across four accounts" hides
 * both the one that is exhausted and the one that has not been touched.
 *
 * The accounts are the gateway's whole list, in its own priority order — the
 * order it will spend them in — and they are carried as the snapshot's
 * `accounts` rather than inferred from whatever came back with windows. An
 * account the gateway has turned off, or whose credential no longer answers, has
 * no window to carry its name, and a page that lists only the accounts that
 * happened to report is a page that never says they exist. So a silent account
 * is drawn too, saying its own state, and only then does the reading have an
 * answer for "where did my account go".
 *
 * It is read in one call, plus one per account, all on the gateway's own HTTP
 * API:
 *
 *   GET /api/providers/client?accountStatus=all&sort=priority&pageSize=…
 *     → { connections: [{ id, provider, name, isActive, priority, … }], … }
 *       already filtered to the connections 9Router can report usage for
 *       (`isUsageEligible` there), which is why this route is used and not the
 *       unfiltered `/api/providers`. `accountStatus=all` and not `active`: a
 *       turned-off account is a fact about the machine, and the gateway's own
 *       page offers it as a filter rather than hiding it.
 *   GET /api/usage/<connectionId>
 *     → { plan?, quotas: { "<label>": { used, total, remaining,
 *         remainingPercentage, resetAt, unlimited } } }  — or `{ message }`
 *       when that account has nothing to report, which is not a failure.
 *
 * **The gateway's API key is not the credential here.** `sk-…` keys authorize
 * `/v1` inference only; every `/api/*` dashboard route is behind the dashboard
 * session (`src/dashboardGuard.js`). So the reading is: try it bare — which is
 * the whole answer on an installation with `requireLogin` off — and on a 401
 * log in with the dashboard password (`ProfileUsage.apiKey`, the one place a
 * separate credential was always meant to go) for an `auth_token` cookie, then
 * retry. A 401 with no password configured says so in words rather than
 * reading as "no plan".
 */

const NINEROUTER_HOST = "http://localhost:20128";
/** The gateway takes up to 500 per page; the cap is what stops a gateway with
    hundreds of linked accounts from becoming hundreds of upstream calls behind
    one refresh. ponytail: a flat cap, a summary line when someone actually has
    more. */
const NINEROUTER_MAX_CONNECTIONS = 40;

interface NineRouterConnection {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
  email?: unknown;
  displayName?: unknown;
  isActive?: unknown;
  priority?: unknown;
}

interface NineRouterQuota {
  used?: unknown;
  total?: unknown;
  remaining?: unknown;
  remainingPercentage?: unknown;
  /** Epoch ms, epoch seconds or ISO — `when` takes all three. */
  resetAt?: unknown;
  unlimited?: unknown;
  /** What `used`/`total` count, when the handler said (Qoder's credits). */
  unit?: unknown;
  /** The handler's own name for the window (Antigravity's model rows). */
  displayName?: unknown;
}

interface NineRouterUsageBody {
  plan?: unknown;
  quotas?: Record<string, NineRouterQuota> | null;
  /** What an account with nothing to report says, and what an expired
      credential says. Kept, never thrown. */
  message?: unknown;
  error?: unknown;
}

/** One account, as the fold sees it: the gateway's row and whatever its own
    usage call answered. */
interface NineRouterEntry {
  connection: NineRouterConnection;
  usage: NineRouterUsageBody;
}

/** The gateway's origin. An override is used whole (minus a trailing slash);
    otherwise the profile's own base URL is the gateway — it is the same server,
    `…:20128/v1` — and its path is dropped. */
export function nineRouterHost(profile: Profile, usage: ProfileUsage): string {
  const override = usage.baseUrl?.trim().replace(/\/+$/, "");
  if (override) return override;
  const base = profile.baseUrl?.trim();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      /* Not a URL — fall through to the default rather than fetching nonsense. */
    }
  }
  return NINEROUTER_HOST;
}

/** Whether the gateway would spend this account at all. `isActive` missing is
    active: an installation that predates the column has no turned-off ones. */
const nineRouterActive = (connection: NineRouterConnection): boolean => connection.isActive !== false;

/** What to call an account in a label and an id: the name the gateway shows,
    else the login it belongs to, else what it is. */
function nineRouterWho(connection: NineRouterConnection): string {
  const pick = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  return (
    pick(connection.name) ||
    pick(connection.displayName) ||
    pick(connection.email) ||
    pick(connection.provider) ||
    "account"
  );
}

/** One account's reading of one window, before grouping: how full it is, and
    the amounts behind that where they mean something. A window with nothing to
    derive a percentage from is dropped — a shape that moved is visible in
    `raw`, never drawn as 0%.
 *
    `unlimited` is *not* dropped. It is a fact about a window with a real spend
    beside it (Vercel's `Used (USD)`), and leaving it out is how a
    pay-as-you-go account reads as having no windows at all. The flag travels
    with the reading and the renderer decides how to draw a window nothing is
    counted against. */
function nineRouterReading(
  quota: NineRouterQuota,
): { usedPercent: number; used: number | null; cap: number | null } | null {
  if (!quota || typeof quota !== "object") return null;
  const used = num(quota.used);
  const total = num(quota.total);
  const remaining = num(quota.remaining);
  const remainingPercent = num(quota.remainingPercentage);
  /* `remainingPercentage` is the gateway's own figure and wins where it is
     there. Otherwise the spend is derived — from `remaining` when it is the
     same kind of number as `total` (an absolute remainder, as Kiro and Qoder
     report), else from the percentage itself. A handler that normalized to
     `total: 100, remaining: 30` is saying 30% remaining, not 0.3%; one that
     counted `total: 1200, remaining: 900` is saying a quarter used. Both go
     through the same guard, so neither has to be special-cased by provider. */
  const spent =
    used ??
    (remaining !== null && total !== null && total > 0 && !(total === 100 && remaining <= 100)
      ? total - remaining
      : null);
  const usedPercent =
    remainingPercent !== null
      ? Math.max(0, Math.min(100, 100 - remainingPercent))
      : spent !== null && total !== null && total > 0
        ? pct(spent, total)
        : total === 100 && remaining !== null
          ? Math.max(0, Math.min(100, 100 - remaining))
          : quota.unlimited === true && spent !== null
            ? pct(spent, spent)
            : null;
  if (usedPercent === null) return null;
  /* The spend is kept whenever it is a number — an unlimited window's `5 USD`
     is a real figure and the whole reading for it. The *cap* is the half that
     has to earn its place: a `total: 100` is the percentage said twice, and a
     `total: 0` is no cap at all, and a tile showing "5 / 0" or "40 / 100" is
     either nonsense or a repeat. A window with a spent figure and no cap draws
     the figure alone. */
  const capped = total !== null && total > 0 && total !== 100;
  return { usedPercent, used: spent, cap: capped ? total : null };
}

/* The gateway's dashboard does not draw its handlers' raw quota keys: it runs
   them through one provider-aware normalizer (`ProviderLimits/utils.js`,
   `parseQuotaData`) before anything is named or counted, and reading the same
   `/api/usage/<id>` body without it is how the same account came out labelled
   `spark_weekly` here and "Spark (Weekly)" there. What that function does that
   the raw body does not say is below; everything else it does — the percentage,
   which is `remainingPercentage` else `used`/`total`, and dropping a row it
   cannot read — this adapter already did. */

/** Codex names its windows after the rate-limit snapshot they came from; the
    gateway names them after the period they are. */
const NINEROUTER_CODEX_LABELS: Record<string, string> = {
  session: "5h",
  weekly: "Weekly",
  spark_session: "Spark (5h)",
  spark_weekly: "Spark (Weekly)",
  review_session: "Review (5h)",
  review_weekly: "Review (Weekly)",
};

/** Qoder names its buckets after who owns them. */
const NINEROUTER_QODER_LABELS: Record<string, string> = {
  user: "Personal",
  organization: "Organization",
};

/** What a window is called when nothing more specific is known. The handler's
    `displayName` when it gave one (Antigravity's rows), else the key. */
function nineRouterLabel(quota: NineRouterQuota, key: string): string {
  return (typeof quota?.displayName === "string" && quota.displayName.trim()) || key;
}

/** Upstream's own reading, for a comparison that has to happen on the same
    number the gateway's page sorts by: `remaining` when it is a percentage,
    `remainingPercentage`, else the pair, else 0 on an `unlimited` window. */
function nineRouterRemaining(quota: NineRouterQuota): number {
  const remaining = num(quota?.remaining);
  if (quota?.unlimited === true) return 100;
  if (remaining !== null && remaining <= 100) return remaining;
  const remainingPercent = num(quota?.remainingPercentage);
  if (remainingPercent !== null) return remainingPercent;
  const used = num(quota?.used);
  const total = num(quota?.total);
  return used !== null && total !== null && total > 0 ? (1 - used / total) * 100 : 0;
}

/** The windows of one account, named the way the gateway's own dashboard names
    them, in the order it draws them: `[id, label, quota]`.

    Two providers need more than a rename and are read off `parseQuotaData`
    exactly — see `nineRouterAntigravity` and the Qoder bucket below. Everything
    else keeps the gateway's own insertion order and its own key, which is what
    the mixed-provider list amounts to: upstream runs the same `Object.entries`
    with no sort of its own for a provider it has no case for. */
function nineRouterWindows(
  connection: NineRouterConnection,
  quotas: Record<string, NineRouterQuota>,
): [string, string, NineRouterQuota][] {
  const entries = Object.entries(quotas);
  const provider = typeof connection.provider === "string" ? connection.provider.toLowerCase() : "";
  if (provider === "antigravity") return nineRouterAntigravity(entries);
  return entries.flatMap(([key, quota]) => {
    /* A personal Qoder account carries an empty `organization` bucket; the
       gateway skips it rather than drawing 0/0. */
    if (provider === "qoder" && key === "organization" && (num(quota?.total) ?? 0) === 0) return [];
    const label =
      provider === "codex"
        ? (NINEROUTER_CODEX_LABELS[key] ?? key)
        : provider === "qoder"
          ? nineRouterLabel(quota, NINEROUTER_QODER_LABELS[key] ?? key)
          : nineRouterLabel(quota, key);
    return [[key, label, quota] as [string, string, NineRouterQuota]];
  });
}

/** Antigravity reports a window per *model*, and the set moves with the model
    rollout, so no fixed key list survives it. The gateway draws one bar per
    *family* instead — the family's **worst** window, because the model that runs
    out first is what gates the account — and keeps everything else as it is.

    The same partition `parseQuotaData` makes, in the order it draws them:
    every `gemini-` model that is not an image is the Gemini family and every
    `claude-` model the Claude one, both collapsed to their worst; then the
    weekly rows and the image models, each under its own name; then anything
    else the provider added, which keeps its key. */
function nineRouterAntigravity(entries: [string, NineRouterQuota][]): [string, string, NineRouterQuota][] {
  const isImage = (key: string) => key.includes("image");
  const family = (key: string): string | null =>
    isImage(key) ? null : key.startsWith("gemini-") ? "gemini" : key.startsWith("claude-") ? "claude" : null;
  const names: Record<string, string> = { gemini: "Gemini (Flash / Pro)", claude: "Claude (Sonnet / Opus)" };
  const out: [string, string, NineRouterQuota][] = [];
  const worst = new Map<string, [string, NineRouterQuota]>();

  for (const [key, quota] of entries) {
    const name = family(key);
    if (!name) continue;
    const standing = worst.get(name);
    /* Keyed on the family, not the model, so the row is stable across a refresh
       that changes which model is worst. */
    if (!standing || nineRouterRemaining(quota) < nineRouterRemaining(standing[1])) worst.set(name, [key, quota]);
  }
  for (const [name, [, quota]] of worst) out.push([name, names[name], quota]);

  /* Everything that is not a model of one of the two families: the weekly
     allowances (`gemini_weekly`, `claude_gpt_weekly`, already worst-cased by the
     gateway's own handler), the image models, and whatever else. Each keeps its
     own key and takes the handler's `displayName` where it gave one. */
  for (const [key, quota] of entries) {
    if (family(key)) continue;
    out.push([key, nineRouterLabel(quota, key), quota]);
  }
  return out;
}

/** What the account's section is headed with. The gateway's own name for it,
    and the plan that account is on when its handler reported one (`plan`) —
    "Work Max · Claude Code", which is the same two facts a z.ai card puts in
    its name and its badge. A name already carrying the plan is left alone
    rather than saying it twice. */
function nineRouterGroup(connection: NineRouterConnection, body: NineRouterUsageBody): string {
  const who = nineRouterWho(connection);
  const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
  if (!plan || who.toLowerCase().includes(plan.toLowerCase())) return who;
  return `${who} · ${plan}`;
}

/** The usable reading of one account: its named windows, its fullest one, and
    the buckets upstream drops before anything is drawn. Shared by the drawing
    fold and the account list so a silent account and a reporting one cannot
    disagree about how many windows it has. */
function nineRouterAccount(
  connection: NineRouterConnection,
  usage: NineRouterUsageBody,
): { windows: QuotaWindow[]; peak: { usedPercent: number; resetsAt: number | null } | null } {
  const quotas = usage?.quotas;
  if (!quotas || typeof quotas !== "object") return { windows: [], peak: null };
  const id = typeof connection.id === "string" ? connection.id : nineRouterWho(connection);
  const windows: QuotaWindow[] = [];
  let peak: { usedPercent: number; resetsAt: number | null } | null = null;

  for (const [key, label, quota] of nineRouterWindows(connection, quotas)) {
    const reading = nineRouterReading(quota);
    /* A window the gateway can read and this adapter cannot is upstream's to
       drop too: `parseQuotaData` filters it out of the tiles, so counting it in
       `accounts.windows` would promise a bar the gateway's own page never drew. */
    if (!reading) continue;
    const resetsAt = when(quota.resetAt);
    windows.push({
      id: `${id}:${key}`,
      /* The window's own name: the account is said once, on the section it
         heads, and repeating it in every tile beneath it is the noise that
         made eight accounts unreadable. */
      label,
      ...reading,
      unit: typeof quota.unit === "string" ? quota.unit : null,
      resetsAt,
      unlimited: quota.unlimited === true,
    });
    if (!peak || reading.usedPercent > peak.usedPercent) peak = { usedPercent: reading.usedPercent, resetsAt };
  }
  return { windows, peak };
}

/** A turned-off account is never asked — the call would disagree with the
    gateway's own reading of its rotation — so it folds as nothing at all. */
const EMPTY_ACCOUNT = { windows: [] as QuotaWindow[], peak: null } as {
  windows: QuotaWindow[];
  peak: { usedPercent: number; resetsAt: number | null } | null;
};

/** What an account with nothing to draw says for itself. The gateway's own
    words when it left a message — a logged-out Codex, a provider with no usage
    API — else the adapter's plainest reading of the same state. */
function nineRouterState(usage: NineRouterUsageBody): string {
  const message = typeof usage?.message === "string" ? usage.message.trim() : "";
  if (message) return message;
  const error = typeof usage?.error === "string" ? usage.error.trim() : "";
  if (error) return error;
  return "No quota reported for this account";
}

export function foldNineRouterQuota(
  entries: NineRouterEntry[],
  /** How many eligible accounts the gateway has, when it said — the list is one
      page and the cap is this adapter's, so the accounts past it are not
      "not reporting", they are not read at all. */
  linked = entries.length,
): Fold & { accounts: QuotaAccount[] } {
  const windows: QuotaWindow[] = [];
  const accounts: QuotaAccount[] = [];
  /* Two accounts the gateway shows the same name for would otherwise be drawn
     as one section, which is the one thing `group` must not let happen. */
  const taken = new Map<string, number>();

  for (const { connection, usage } of entries) {
    const id = typeof connection.id === "string" ? connection.id : nineRouterWho(connection);
    const disabled = !nineRouterActive(connection);
    const { windows: accountWindows, peak } = disabled ? EMPTY_ACCOUNT : nineRouterAccount(connection, usage);

    /* The one string this account's windows carry and the one a renderer joins
       on. Claimed on the account's first readable window, so a name is only
       disambiguated against accounts that are actually drawn — and held for a
       silent account too, so the list is stable across a refresh that happens
       to land between the two. */
    const groupClaim = nineRouterGroup(connection, usage);
    const seen = taken.get(groupClaim) ?? 0;
    taken.set(groupClaim, seen + 1);
    const suffix = seen > 0 ? ` (${seen + 1})` : "";
    const group = `${groupClaim}${suffix}`;
    for (const window of accountWindows) windows.push({ ...window, group });

    const plan = typeof usage?.plan === "string" && usage.plan.trim() ? usage.plan.trim() : null;
    /* The disambiguator rides the *name* as well as the group, because a heading
       has no room for a second line and two accounts called `Claude` with
       different bars are otherwise two identical sections. */
    const who = `${nineRouterWho(connection)}${suffix}`;
    accounts.push({
      id,
      group,
      name: who,
      provider: typeof connection.provider === "string" ? connection.provider : null,
      /* The plan only when the name does not already say it — the same rule the
         group string follows, so a heading and its subtitle cannot repeat. */
      plan: plan && !who.toLowerCase().includes(plan.toLowerCase()) ? plan : null,
      windows: accountWindows.length,
      usedPercent: peak ? peak.usedPercent : null,
      resetsAt: peak ? peak.resetsAt : null,
      disabled,
      /* An account with windows is saying what it has; a silent one is saying
         why it is silent, and the two never both apply. */
      state: accountWindows.length || disabled ? null : nineRouterState(usage),
    });
  }

  /* Deliberately unsorted: the gateway hands its connections back in priority
     order — the order it will actually spend them in — so the first section is
     the account serving now and the last is the free tier behind everything.
     Sorting by fullness would scramble exactly the fact a fallback chain has to
     show. Within an account the order is the gateway's too. */

  const reporting = accounts.filter((account) => account.windows > 0).length;
  const off = accounts.filter((account) => account.disabled).length;
  const quiet = accounts.length - reporting - off;
  const unread = Math.max(0, linked - entries.length);
  /* A count and its noun, plural only where the noun is one — "3 not shown"
     needs no `s`, "2 accounts" does. */
  const say = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const extras: string[] = [];
  if (off > 0) extras.push(say(off, "off", "off"));
  if (quiet > 0) extras.push(say(quiet, "not reporting", "not reporting"));
  /* `+` because these were never asked: they are not quiet, they are past the
     page the adapter reads. */
  if (unread > 0) extras.push(`+${unread} not shown`);

  return {
    status: windows.length ? "subscription" : "api-key",
    windows,
    accounts,
    /* Every account's answer, named and in full — the sections are what folded,
       and an account that is expired, throttled or simply has no usage API is
       only answerable here. */
    raw: JSON.stringify(entries, null, 2),
    /* No single plan: the gateway is several, and how many of them are actually
       behind the bars is the honest headline. */
    planName: accounts.length
      ? `9Router · ${say(reporting, "account")}${extras.length ? ` (${extras.join(", ")})` : ""}`
      : null,
    credits: null,
  };
}

async function readNineRouterUsage(profile: Profile, usage: ProfileUsage): Promise<Fold & { accounts: QuotaAccount[] }> {
  const host = nineRouterHost(profile, usage);
  const password = usage.apiKey?.trim() || "";
  let cookie = "";

  /** GET a dashboard route, logging in once on a 401 when a password is set.
      The cookie is kept for the calls after it, so the login happens at most
      once per reading. */
  const get = async <T>(path: string): Promise<{ body: T; status: number }> => {
    const ask = () =>
      fetchJson<T>(host + path, { method: "GET", headers: cookie ? { Cookie: cookie } : {} }, "9Router");
    let res = await ask();
    if (res.status === 401 && !cookie) {
      if (!password)
        throw new Error(
          "9Router's dashboard requires a login: put its dashboard password in the plan usage token field",
        );
      const login = await fetch(host + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });
      const auth = login.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .find((c) => c.startsWith("auth_token="));
      if (!auth) throw new Error(`9Router login failed (${login.status}): check the dashboard password`);
      cookie = auth;
      res = await ask();
    }
    return res;
  };

  const { body, status } = await get<{
    connections?: NineRouterConnection[];
    pagination?: { total?: unknown };
  }>(
    `/api/providers/client?accountStatus=all&sort=priority&pageSize=${NINEROUTER_MAX_CONNECTIONS}`,
  );
  const httpFold = httpStatus(status);
  if (httpFold)
    return {
      status: httpFold,
      windows: [],
      accounts: [],
      raw: JSON.stringify(body, null, 2),
      planName: null,
      credits: null,
    };

  const connections = (body?.connections ?? []).slice(0, NINEROUTER_MAX_CONNECTIONS);
  const entries = await Promise.all(
    connections.map(async (connection) => {
      /* A turned-off account is not asked: the gateway is not spending it, its
         quota call is the one most likely to be a stale credential, and the
         account is the gateway's own state to report — not a provider's answer
         this adapter would be second-guessing. */
      if (!nineRouterActive(connection)) return { connection, usage: {} };
      /* One account failing is that account's row, never the reading's: a
         revoked Codex login must not blank the Claude subscription beside it. */
      try {
        const res = await get<NineRouterUsageBody>(`/api/usage/${encodeURIComponent(String(connection.id))}`);
        return { connection, usage: res.body };
      } catch (err) {
        return { connection, usage: { message: err instanceof Error ? err.message : String(err) } };
      }
    }),
  );
  return foldNineRouterQuota(entries, num(body?.pagination?.total) ?? entries.length);
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
    case "command-code":
      return readCommandCodeUsage(profile, usage);
    case "9router":
      return readNineRouterUsage(profile, usage);
    default:
      /* Deliberately not a fall-through to some default adapter: a `kind` this
         build does not know is a profile written by a newer one, and answering
         it with the wrong provider's parser invents numbers. */
      return Promise.reject(new Error(`unknown usage provider: ${usage.kind}`));
  }
}

export type { ProfileUsage, ProfileUsageKind };
