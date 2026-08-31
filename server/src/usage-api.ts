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
// The dispatch
// ---------------------------------------------------------------------------

/**
 * Read this profile's provider usage. Throws when there is no provider, when
 * the call fails, or when the answer is unreadable — `quota.ts` turns any of
 * those into an `error` snapshot, the same way it does for a probe.
 */
export function readProfileUsage(
  profile: Profile,
): Promise<Pick<QuotaSnapshot, "status" | "windows" | "raw" | "planName">> {
  const usage = profileUsage(profile);
  if (!usage) return Promise.reject(new Error("this profile names no usage provider"));
  switch (usage.kind) {
    case "zai":
      return readZaiUsage(profile, usage);
    default:
      /* Deliberately not a fall-through to some default adapter: a `kind` this
         build does not know is a profile written by a newer one, and answering
         it with the wrong provider's parser invents numbers. */
      return Promise.reject(new Error(`unknown usage provider: ${usage.kind}`));
  }
}

export type { ProfileUsage, ProfileUsageKind };
