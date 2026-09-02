// Self-check for the subscription-quota parsers (src/quota.ts):
//   - parseClaudeUsage reads the report `/usage` prints, through the JSON
//     envelope `--output-format json` puts around it and bare;
//   - it reports "api-key" / "unauthenticated" instead of inventing windows,
//     and always keeps the runtime's own text;
//   - foldCodexQuota turns account/rateLimits/read into the same shape, and
//     reads codex's refusal on an API-key install as "no plan", not as a fault;
//   - foldZaiQuota (src/usage-api.ts) does the same for a PROVIDER's plan — the
//     other reader, chosen by the profile rather than the agent — including the
//     (unit, number) pair z.ai describes a window with, and zaiQuotaUrl picks
//     the platform the profile's own base URL implies;
//   - the MiniMax, Kimi, Synthetic, DeepSeek and OpenRouter folds do the same
//     for their providers' routes — each fixture is the shape the route answers
//     (the rejections are verbatim captures; the successes follow the fields
//     the providers' own dashboards read).
//
// Pure functions only: no processes, no database. The fixtures are what the two
// runtimes actually answered on a real install — the Claude report is a verbatim
// capture, the codex payload follows `codex app-server generate-json-schema`'s
// GetAccountRateLimitsResponse and the codex refusal is its verbatim error.
// Run: pnpm test:quota
import assert from "node:assert/strict";

const { parseClaudeUsage, foldCodexQuota } = await import("../src/quota.js");
const {
  foldZaiQuota,
  zaiQuotaUrl,
  foldMinimaxQuota,
  minimaxQuotaUrl,
  foldKimiQuota,
  kimiQuotaUrl,
  foldSyntheticQuota,
  foldDeepseekQuota,
  foldOpenrouterQuota,
} = await import("../src/usage-api.js");

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- Claude Code -----------------------------------------------------------

const CLAUDE_REPORT = `You are currently using your subscription to power your Claude Code usage

Current session: 3% used · resets Aug 31, 9:59am (Africa/Cairo)
Current week (all models): 35% used · resets Sep 4, 12:59am (Africa/Cairo)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.

Last 24h · 2574 requests · 74 sessions
  50% of your usage was at >150k context`;

const claudeEnvelope = (result: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result });

test("parseClaudeUsage reads both windows out of the JSON envelope", () => {
  const snap = parseClaudeUsage(claudeEnvelope(CLAUDE_REPORT));
  assert.equal(snap.status, "subscription");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.usedPercent, w.resetsLabel]),
    [
      ["five_hour", 3, "Aug 31, 9:59am (Africa/Cairo)"],
      ["seven_day", 35, "Sep 4, 12:59am (Africa/Cairo)"],
    ],
  );
  assert.equal(snap.windows[0].label, "Current session");
  assert.equal(snap.windows[1].label, "Current week (all models)");
  assert.equal(snap.windows[0].windowMinutes, 300);
  assert.equal(snap.windows[1].windowMinutes, 10080);
});

test("parseClaudeUsage keeps the report as raw, unwrapped", () => {
  // The envelope is transport; what a reader needs when a line stops parsing is
  // the report itself.
  assert.equal(parseClaudeUsage(claudeEnvelope(CLAUDE_REPORT)).raw, CLAUDE_REPORT);
});

test("parseClaudeUsage handles a bare (non-JSON) report", () => {
  const snap = parseClaudeUsage(CLAUDE_REPORT);
  assert.equal(snap.status, "subscription");
  assert.equal(snap.windows.length, 2);
});

test("parseClaudeUsage keeps a per-model weekly window apart from the overall one", () => {
  const snap = parseClaudeUsage(
    "Current week (all models): 35% used · resets Sep 4, 1am\nCurrent week (Opus): 12% used · resets Sep 4, 1am",
  );
  assert.deepEqual(snap.windows.map((w) => w.id), ["seven_day", "seven_day_opus"]);
  assert.equal(snap.windows[1].usedPercent, 12);
});

test("parseClaudeUsage tolerates a window with no reset clause", () => {
  const snap = parseClaudeUsage("Current session: 7% used");
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].usedPercent, 7);
  assert.equal(snap.windows[0].resetsLabel, undefined);
});

test("parseClaudeUsage reports an API-key install rather than a zeroed plan", () => {
  const snap = parseClaudeUsage(claudeEnvelope("You are using an API key, billed to your Anthropic Console account."));
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
});

test("parseClaudeUsage reports a logged-out install", () => {
  const snap = parseClaudeUsage(claudeEnvelope("Please run /login to authenticate."));
  assert.equal(snap.status, "unauthenticated");
});

test("parseClaudeUsage refuses to guess at prose it does not know", () => {
  const snap = parseClaudeUsage(claudeEnvelope("Something else entirely."));
  assert.equal(snap.status, "error");
  assert.equal(snap.raw, "Something else entirely.");
});

// ---- Codex -----------------------------------------------------------------

test("foldCodexQuota reads primary and secondary windows", () => {
  const snap = foldCodexQuota({
    account: { type: "chatgpt" },
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 12, resetsAt: 1_788_150_000, windowDurationMins: 300 },
      secondary: { usedPercent: 61, resetsAt: 1_788_500_000, windowDurationMins: 10_080 },
      credits: { balance: "5.00", hasCredits: true, unlimited: false },
    },
  });
  assert.equal(snap.status, "subscription");
  assert.equal(snap.planName, "pro");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, w.usedPercent]),
    [
      ["primary", "5h limit", 12],
      ["secondary", "Weekly limit", 61],
    ],
  );
  // Codex reports unix seconds; the snapshot is epoch ms, like everything else.
  assert.equal(snap.windows[0].resetsAt, 1_788_150_000_000);
  assert.deepEqual(snap.credits, { balance: "5.00", unlimited: false });
});

test("foldCodexQuota prefers the backend's own limit name for the primary window", () => {
  const snap = foldCodexQuota({
    rateLimits: { limitName: "Codex usage", primary: { usedPercent: 4, windowDurationMins: null } },
  });
  assert.equal(snap.windows[0].label, "Codex usage");
  assert.equal(snap.windows[0].resetsAt, null);
});

test("foldCodexQuota reads an API-key install as no plan, not as a failure", () => {
  // Verbatim: what codex answers when ~/.codex/auth.json is auth_mode: apikey.
  const snap = foldCodexQuota({
    account: { type: "apiKey" },
    rateLimitError: "chatgpt authentication required to read rate limits",
  });
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.raw, "chatgpt authentication required to read rate limits");
});

test("foldCodexQuota reads the refusal alone as no plan", () => {
  // account/read may not have answered; the refusal alone still says enough.
  assert.equal(
    foldCodexQuota({ rateLimitError: "chatgpt authentication required to read rate limits" }).status,
    "api-key",
  );
});

test("foldCodexQuota reports an unrelated failure as an error", () => {
  const snap = foldCodexQuota({ rateLimitError: "internal server error" });
  assert.equal(snap.status, "error");
  assert.equal(snap.raw, "internal server error");
});

test("foldCodexQuota drops a window with no percentage rather than reading it as zero", () => {
  const snap = foldCodexQuota({ account: { type: "chatgpt" }, rateLimits: { primary: null, secondary: null } });
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.status, "unauthenticated");
});

// ---------------------------------------------------------------------------
// Z.AI / Zhipu GLM Coding Plan — the provider-side reader
// ---------------------------------------------------------------------------

/* The body `GET /api/monitor/usage/quota/limit` answers. `unit: 3, number: 5`
   is the rolling five hours and `unit: 6, number: 1` the week; `TIME_LIMIT` is
   the monthly MCP tool allowance, whose percentage is the only field of it the
   card draws. `nextResetTime` is epoch milliseconds, unlike codex's seconds. */
const ZAI_REPORT = {
  data: {
    level: "pro",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40.5, nextResetTime: 1_788_150_000_000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 52, nextResetTime: 1_788_500_000_000 },
      {
        type: "TIME_LIMIT",
        percentage: 12.3,
        currentValue: 123,
        usage: 1000,
        usageDetails: [{ modelCode: "web-reader", usage: 2345 }],
      },
    ],
  },
};

const zaiProfile = (baseUrl = "") =>
  ({ id: "p", name: "z.ai", agents: {}, baseUrl, apiKey: "k", models: [], defaultModel: "", smallModel: "", logoUrl: "" }) as never;

test("foldZaiQuota reads both token windows and the MCP allowance", () => {
  const snap = foldZaiQuota(ZAI_REPORT);
  assert.equal(snap.status, "subscription");
  assert.equal(snap.planName, "pro");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, w.usedPercent, w.windowMinutes]),
    [
      // The same ids Claude Code's adapter mints for the same shapes of window.
      ["five_hour", "Token usage (5 hour)", 40.5, 300],
      ["seven_day", "Token usage (weekly)", 52, 10080],
      ["mcp_monthly", "MCP tool usage (monthly)", 12.3, 43200],
    ],
  );
  assert.equal(snap.windows[0].resetsAt, 1_788_150_000_000);
});

test("foldZaiQuota keeps the body verbatim, because the endpoint is undocumented", () => {
  assert.deepEqual(JSON.parse(foldZaiQuota(ZAI_REPORT).raw), ZAI_REPORT);
});

test("foldZaiQuota labels a window whose unit it does not know rather than dropping it", () => {
  const snap = foldZaiQuota({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 9, number: 2, percentage: 7 }] } });
  assert.equal(snap.windows.length, 1);
  assert.equal(snap.windows[0].label, "Token usage (unit 9, number 2)");
  // No invented duration: a wrong windowMinutes becomes a wrong label and sort.
  assert.equal(snap.windows[0].windowMinutes, null);
  assert.equal(snap.status, "subscription");
});

test("foldZaiQuota reads an account with no coding plan as no plan, not as a failure", () => {
  const snap = foldZaiQuota({ code: 200, msg: "success", data: { limits: [] } });
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
});

test("foldZaiQuota reads a rejected key as unauthenticated", () => {
  assert.equal(foldZaiQuota({ code: 401, msg: "invalid api key" }, 401).status, "unauthenticated");
});

test("foldZaiQuota reads a 200 the body itself calls an error as an error", () => {
  const snap = foldZaiQuota({ code: 1302, msg: "rate limit reached" }, 200);
  assert.equal(snap.status, "error");
  assert.match(snap.raw, /rate limit reached/);
});

test("foldZaiQuota drops a limit with no percentage rather than reading it as zero", () => {
  const snap = foldZaiQuota({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5 }] } });
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.status, "api-key");
});

test("zaiQuotaUrl picks the platform from the profile's own base URL", () => {
  assert.equal(
    zaiQuotaUrl(zaiProfile("https://api.z.ai/api/anthropic"), { kind: "zai" }),
    "https://api.z.ai/api/monitor/usage/quota/limit",
  );
  // A CN gateway is a CN account, and its key is not the global platform's.
  assert.equal(
    zaiQuotaUrl(zaiProfile("https://open.bigmodel.cn/api/coding/paas/v4"), { kind: "zai" }),
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  );
});

// ---- MiniMax ---------------------------------------------------------------

const MINIMAX_REPORT = {
  base_resp: { status_code: 0, status_msg: "success" },
  data: {
    plan_name: "Coding Plan Pro",
    model_remains: [
      {
        model_name: "MiniMax-M3",
        current_interval_total_count: 1500,
        current_interval_usage_count: 300,
        start_time: 1_788_150_000_000,
        end_time: 1_788_168_000_000,
        current_interval_remaining_percent: 80,
        current_weekly_total_count: 10_000,
        current_weekly_usage_count: 1_000,
        weekly_end_time: 1_788_500_000_000,
        current_weekly_remaining_percent: 90,
      },
      {
        model_name: "MiniMax-M2.7",
        current_interval_total_count: 1000,
        current_interval_usage_count: 900,
        start_time: 1_788_150_000_000,
        end_time: 1_788_168_000_000,
        current_weekly_total_count: 5000,
        current_weekly_usage_count: 100,
        weekly_end_time: 1_788_500_000_000,
      },
    ],
  },
};

test("foldMinimaxQuota reads the fullest model's 5-hour and weekly counters", () => {
  const snap = foldMinimaxQuota(MINIMAX_REPORT);
  assert.equal(snap.status, "subscription");
  assert.equal(snap.planName, "Coding Plan Pro");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, w.usedPercent, w.windowMinutes, w.resetsAt]),
    [
      ["five_hour", "Requests (5 hour) · MiniMax-M2.7", 90, 300, 1_788_168_000_000],
      ["seven_day", "Requests (weekly) · MiniMax-M3", 10, 10080, 1_788_500_000_000],
    ],
  );
});

test("foldMinimaxQuota reads the fields at the root when there is no data envelope", () => {
  const { data, ...rest } = MINIMAX_REPORT;
  const snap = foldMinimaxQuota({ ...rest, ...data });
  assert.equal(snap.windows.length, 2);
});

test("foldMinimaxQuota reads the provider's 1004 as unauthenticated even on a 200", () => {
  // Verbatim: what api.minimax.io answers a bad key, with HTTP 200.
  const snap = foldMinimaxQuota(
    { base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key in the 'Authorization' field of the request header" } },
    200,
  );
  assert.equal(snap.status, "unauthenticated");
  assert.match(snap.raw, /API secret key/);
});

test("foldMinimaxQuota reads an empty model list on a good key as no plan", () => {
  assert.equal(foldMinimaxQuota({ base_resp: { status_code: 0 }, data: { model_remains: [] } }).status, "api-key");
});

test("minimaxQuotaUrl picks the platform from the profile's own base URL", () => {
  assert.equal(minimaxQuotaUrl(zaiProfile("https://api.minimax.io/anthropic"), { kind: "minimax" }), "https://api.minimax.io/v1/token_plan/remains");
  assert.equal(minimaxQuotaUrl(zaiProfile("https://api.minimaxi.com/v1"), { kind: "minimax" }), "https://api.minimaxi.com/v1/token_plan/remains");
  assert.equal(minimaxQuotaUrl(zaiProfile(), { kind: "minimax", baseUrl: "https://proxy.example/" }), "https://proxy.example/v1/token_plan/remains");
});

// ---- Kimi ------------------------------------------------------------------

const KIMI_REPORT = {
  usage: { limit: "2000", used: "312", remaining: "1688", resetTime: "2026-09-08T00:00:00Z" },
  limits: [
    { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "200", used: "17", remaining: "183", resetTime: "2026-09-02T15:00:00Z" } },
  ],
};

test("foldKimiQuota reads the rolling window and the weekly allowance, counts as strings", () => {
  const snap = foldKimiQuota(KIMI_REPORT);
  assert.equal(snap.status, "subscription");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, Math.round(w.usedPercent * 10) / 10, w.windowMinutes]),
    [
      ["five_hour", "Requests (5 hour)", 8.5, 300],
      ["seven_day", "Requests (weekly)", 15.6, 10080],
    ],
  );
  assert.equal(snap.windows[0].resetsAt, Date.parse("2026-09-02T15:00:00Z"));
});

test("foldKimiQuota reads the API's unauthenticated code as such", () => {
  // Verbatim shape of api.kimi.com's 401.
  assert.equal(foldKimiQuota({ code: "unauthenticated", details: [] } as never, 401).status, "unauthenticated");
});

test("kimiQuotaUrl derives the host from a base URL that names the coding API", () => {
  assert.equal(kimiQuotaUrl(zaiProfile("https://api.kimi.com/coding/v1"), { kind: "kimi" }), "https://api.kimi.com/coding/v1/usages");
  assert.equal(kimiQuotaUrl(zaiProfile("https://api.kimi.com/coding"), { kind: "kimi" }), "https://api.kimi.com/coding/v1/usages");
  assert.equal(kimiQuotaUrl(zaiProfile("https://some.gateway/v1"), { kind: "kimi" }), "https://api.kimi.com/coding/v1/usages");
});

// ---- Synthetic -------------------------------------------------------------

test("foldSyntheticQuota reads each named pool with its known duration", () => {
  const snap = foldSyntheticQuota({
    subscription: { limit: 135, requests: 27, renewsAt: "2026-09-02T15:00:00Z" },
    search: { limit: 100, requests: 3, renewsAt: "2026-09-02T13:00:00Z" },
    other: { limit: 10, used: 5 },
  });
  assert.equal(snap.status, "subscription");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, w.usedPercent, w.windowMinutes]),
    [
      ["five_hour", "Requests (5 hour)", 20, 300],
      ["search_hourly", "Search (hourly)", 3, 60],
      ["other", "Other", 50, null],
    ],
  );
});

test("foldSyntheticQuota reads the verbatim invalid-key body as unauthenticated", () => {
  assert.equal(foldSyntheticQuota({ error: "Invalid API Key." }, 401).status, "unauthenticated");
});

// ---- DeepSeek --------------------------------------------------------------

test("foldDeepseekQuota reads the balance as credits on an api-key status, never as a window", () => {
  const snap = foldDeepseekQuota({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" }],
  });
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
  assert.deepEqual(snap.credits, { balance: "12.34 USD", unlimited: false });
});

test("foldDeepseekQuota reads the documented 401 as unauthenticated", () => {
  const snap = foldDeepseekQuota({ error: { message: "Authentication Fails, Your api key: ****alid is invalid" } }, 401);
  assert.equal(snap.status, "unauthenticated");
});

// ---- OpenRouter ------------------------------------------------------------

test("foldOpenrouterQuota draws a key limit as a window and the credits underneath", () => {
  const snap = foldOpenrouterQuota(
    { data: { label: "harness", usage: 1.23, limit: 10, limit_remaining: 8.77, limit_reset: "monthly", is_free_tier: false } },
    { data: { total_credits: 50, total_usage: 31.2 } },
  );
  assert.equal(snap.status, "subscription");
  assert.deepEqual(snap.windows.map((w) => [w.id, w.label, Math.round(w.usedPercent * 100) / 100, w.windowMinutes]), [
    ["key_monthly", "Key spend (monthly) · $10", 12.3, 43200],
  ]);
  assert.deepEqual(snap.credits, { balance: "$18.80 of $50.00", unlimited: false });
});

test("foldOpenrouterQuota reads a key with no limit as api-key, credits still shown", () => {
  const snap = foldOpenrouterQuota({ data: { label: "k", usage: 0.5, limit: null } }, { data: { total_credits: 5, total_usage: 0.5 } });
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.credits?.balance, "$4.50 of $5.00");
});

test("foldOpenrouterQuota reads the verbatim missing-auth body as unauthenticated", () => {
  assert.equal(foldOpenrouterQuota({ error: { message: "Missing Authentication header", code: 401 } }, null, 401).status, "unauthenticated");
});


test("zaiQuotaUrl takes an override as an origin, or whole when it names the route", () => {
  assert.equal(
    zaiQuotaUrl(zaiProfile(), { kind: "zai", baseUrl: "https://proxy.example/" }),
    "https://proxy.example/api/monitor/usage/quota/limit",
  );
  assert.equal(
    zaiQuotaUrl(zaiProfile(), { kind: "zai", baseUrl: "https://proxy.example/x/monitor/usage/quota/limit" }),
    "https://proxy.example/x/monitor/usage/quota/limit",
  );
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
