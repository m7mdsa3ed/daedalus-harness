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
//   - the MiniMax, Kimi, Synthetic, DeepSeek, OpenRouter and Command Code folds
//     do the same for their providers' routes — each fixture is the shape the
//     route answers (the rejections are verbatim captures; the successes follow
//     the fields the providers' own dashboards read).
//
// Pure functions only: no processes, no database. The fixtures are what the two
// runtimes actually answered on a real install — the Claude report is a verbatim
// capture, the codex payload follows `codex app-server generate-json-schema`'s
// GetAccountRateLimitsResponse and the codex refusal is its verbatim error, and
// the Command Code body and its rejected-key answer are verbatim captures.
// Run: pnpm test:quota
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseClaudeUsage, foldCodexQuota, probeHeldBack, setRuntimeLiveCheck } = await import("../src/quota.js");
const {
  foldZaiQuota,
  zaiQuotaUrl,
  foldCommandCodeQuota,
  commandCodeQuotaUrl,
  foldMinimaxQuota,
  minimaxQuotaUrl,
  foldKimiQuota,
  kimiQuotaUrl,
  foldSyntheticQuota,
  foldDeepseekQuota,
  foldOpenrouterQuota,
  foldNineRouterQuota,
  nineRouterHost,
} = await import("../src/usage-api.js");

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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
  // The MCP window is the one z.ai gives amounts for: `currentValue` of `usage`.
  const mcp = snap.windows[2];
  assert.deepEqual([mcp.used, mcp.cap, mcp.unit], [123, 1000, "calls"]);
  // The token windows are a percentage and nothing else, and stay that way.
  assert.equal(snap.windows[0].cap ?? null, null);
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

// ---- Command Code ----------------------------------------------------------

/* Verbatim: what `GET https://api.commandcode.ai/alpha/billing/credits` answered
   for the Go plan this machine is signed into. It is a *provider-side* reading
   even though a runtime's login also owns the account, because Command Code's
   `/usage` has no non-interactive form — the slash command lives only in its
   interactive panel — so the account route is the only reader there is.
   `used`/`cap` are in credits (dollars here) and `resetAt` is epoch ms. */
const COMMAND_CODE_REPORT = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 9.515087384, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.276396188, cap: 3, exceeded: false, resetAt: 1_789_180_183_530 },
    weekly: { used: 0.484912616, cap: 6, exceeded: false, resetAt: 1_789_657_648_583 },
  },
};

test("foldCommandCodeQuota derives both window percentages from used and cap", () => {
  const snap = foldCommandCodeQuota(COMMAND_CODE_REPORT);
  assert.equal(snap.status, "subscription");
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, Math.round(w.usedPercent * 10) / 10, w.windowMinutes, w.resetsAt]),
    [
      // The ids the Claude Code and z.ai adapters mint for the same shapes.
      ["five_hour", "5-hour", 9.2, 300, 1_789_180_183_530],
      ["seven_day", "Weekly", 8.1, 10080, 1_789_657_648_583],
    ],
  );
});

test("foldCommandCodeQuota carries the amounts the percentage came from", () => {
  // The card says "0.28 / 3 credits" beside the bar; a percentage alone cannot
  // tell you whether 9% is nine cents or nine dollars.
  const [five] = foldCommandCodeQuota(COMMAND_CODE_REPORT).windows;
  assert.deepEqual([five.cap, five.unit], [3, "credits"]);
  // Carried raw, not rounded: rounding is the renderer's, which knows its width.
  assert.equal(five.used, COMMAND_CODE_REPORT.windowLimits.fiveHour.used);
});

test("foldCommandCodeQuota keeps both bodies verbatim, because the routes are internal", () => {
  // The envelope names which call said what — two undocumented routes go into
  // this reading, and a shape that moved has to be visible as itself.
  assert.deepEqual(JSON.parse(foldCommandCodeQuota(COMMAND_CODE_REPORT).raw), {
    credits: COMMAND_CODE_REPORT,
    subscription: null,
  });
});

test("foldCommandCodeQuota names the plan off the credits body, with no second call", () => {
  // `credits.planId` rides in on the call we already make; the plan's *name* is
  // the CLI's own table, because no route serves one.
  const snap = foldCommandCodeQuota({ ...COMMAND_CODE_REPORT, credits: { ...COMMAND_CODE_REPORT.credits, planId: "individual-pro" } });
  assert.equal(snap.planName, "Pro");
});

test("foldCommandCodeQuota draws the monthly pot from what is left of it", () => {
  // 9.515 left of the Pro plan's 30 → 20.485 spent, 68.3%.
  const snap = foldCommandCodeQuota({ ...COMMAND_CODE_REPORT, credits: { ...COMMAND_CODE_REPORT.credits, planId: "individual-pro" } });
  const monthly = snap.windows.find((w) => w.id === "monthly")!;
  assert.deepEqual(
    [monthly.label, monthly.cap, Math.round(monthly.usedPercent * 10) / 10, monthly.windowMinutes],
    ["Plan credits (monthly) · Pro", 30, 68.3, 43200],
  );
  assert.equal(snap.windows.at(-1)?.id, "monthly", "the slowest window comes last");
});

test("foldCommandCodeQuota reads the longest matching plan id, not its prefix", () => {
  // `individual-pro-v1` is 80 credits; read as `individual-pro` it would be 30,
  // and every percentage on the card would be wrong.
  const snap = foldCommandCodeQuota({ credits: { monthlyCredits: 40, planId: "INDIVIDUAL_PRO_V1" } });
  assert.equal(snap.windows.find((w) => w.id === "monthly")?.cap, 80);
});

test("foldCommandCodeQuota widens the cap rather than reporting a negative spend", () => {
  // More credits left than the plan gives — a mid-month upgrade.
  const snap = foldCommandCodeQuota({ credits: { monthlyCredits: 45, planId: "individual-pro" } });
  const monthly = snap.windows.find((w) => w.id === "monthly")!;
  assert.deepEqual([monthly.cap, monthly.used], [45, 0]);
});

test("foldCommandCodeQuota draws no monthly pot for a plan that is no longer live", () => {
  // A canceled subscription still names its planId; its allowance is gone.
  const body = { credits: { monthlyCredits: 2, planId: "individual-pro" } };
  const live = foldCommandCodeQuota(body, 200, { data: { status: "trialing", currentPeriodEnd: "2026-10-01T00:00:00Z" } });
  assert.equal(live.windows.find((w) => w.id === "monthly")?.resetsAt, Date.parse("2026-10-01T00:00:00Z"));
  const dead = foldCommandCodeQuota(body, 200, { data: { status: "canceled" } });
  assert.deepEqual(dead.windows, []);
  assert.equal(dead.planName, "Pro", "the plan is still named — it is simply not giving credits");
});

test("foldCommandCodeQuota says nothing about a plan it does not know", () => {
  // An id the table has never heard of: no name, no invented allowance.
  const snap = foldCommandCodeQuota({ credits: { monthlyCredits: 5, planId: "enterprise-moon" } });
  assert.equal(snap.planName, null);
  assert.deepEqual(snap.windows, []);
});

test("foldCommandCodeQuota shows the plan's remaining credits", () => {
  assert.deepEqual(foldCommandCodeQuota(COMMAND_CODE_REPORT).credits, { balance: "9.52 credits", unlimited: false });
});

test("foldCommandCodeQuota totals the three credit pots and names them when there is more than one", () => {
  const snap = foldCommandCodeQuota({ credits: { monthlyCredits: 1, purchasedCredits: 2.5, freeCredits: 0 } });
  assert.equal(snap.credits?.balance, "3.5 credits (1 plan, 2.5 purchased)");
});

test("foldCommandCodeQuota reads pay-as-you-go as no plan, not as a failure", () => {
  // `limited: false` is the endpoint itself saying there are no windows to pace.
  const snap = foldCommandCodeQuota({ credits: { monthlyCredits: 4 }, windowLimits: { limited: false } });
  assert.equal(snap.status, "api-key");
  assert.deepEqual(snap.windows, []);
});

test("foldCommandCodeQuota reads a rejected key as unauthenticated", () => {
  // Verbatim: what the route answers a key that is not the account's, with the
  // HTTP status it answers it under.
  const snap = foldCommandCodeQuota(
    { success: false, error: { code: "UNAUTHORIZED", status: 401, message: "Invalid 'Authorization' header or token." } },
    401,
  );
  assert.equal(snap.status, "unauthenticated");
  assert.match(snap.raw, /Invalid 'Authorization' header/);
});

test("foldCommandCodeQuota errors on a plan whose windows no longer parse", () => {
  // Still claimed to be limited, with nothing readable under it: an empty card
  // would be a lie, so this is the one 200 that is not "no plan".
  const snap = foldCommandCodeQuota({ windowLimits: { limited: true, fiveHour: { used: 1 } } });
  assert.deepEqual(snap.windows, []);
  assert.equal(snap.status, "error");
});

test("foldCommandCodeQuota normalizes a reset given in seconds", () => {
  const snap = foldCommandCodeQuota({
    windowLimits: { limited: true, weekly: { used: 1, cap: 4, resetAt: 1_789_657_648 } },
  });
  assert.equal(snap.windows[0].resetsAt, 1_789_657_648_000);
});

test("commandCodeQuotaUrl picks the platform from the profile's own base URL", () => {
  assert.equal(
    commandCodeQuotaUrl(zaiProfile("https://api.commandcode.ai/provider/v1"), { kind: "command-code" }),
    "https://api.commandcode.ai/alpha/billing/credits",
  );
  // The staging twin's keys are not the production account's.
  assert.equal(
    commandCodeQuotaUrl(zaiProfile("https://staging-api.commandcode.ai/provider/v1"), { kind: "command-code" }),
    "https://staging-api.commandcode.ai/alpha/billing/credits",
  );
});

test("commandCodeQuotaUrl takes an override as an origin, or whole when it names the route", () => {
  assert.equal(
    commandCodeQuotaUrl(zaiProfile(), { kind: "command-code", baseUrl: "https://proxy.example/" }),
    "https://proxy.example/alpha/billing/credits",
  );
  assert.equal(
    commandCodeQuotaUrl(zaiProfile(), {
      kind: "command-code",
      baseUrl: "https://proxy.example/x/alpha/billing/credits",
    }),
    "https://proxy.example/x/alpha/billing/credits",
  );
});

/* ── 9Router: many accounts behind one gateway ──
   The fold is a list of the gateway's own per-connection usage answers, in the
   shape `open-sse/services/usage/*` normalizes to — every fixture below is a
   capture of what the live gateway answered in each state (an account with
   per-model Antigravity rows, a Vercel credits body, a Kiro refusal, a
   turned-off account, a `message`-only body).

   The accounts are read from the gateway's *connection list*, not inferred from
   whatever came back with windows: an account the gateway turned off, or whose
   credential no longer answers, has no window to carry its name, and a page
   that lists only the accounts that reported never says it exists. */

const soon = Date.now() + 60 * 60 * 1000;
const later = Date.now() + 5 * 60 * 60 * 1000;

test("foldNineRouterQuota draws an account's own windows, under its own group", () => {
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "claude", name: "Max account" },
      usage: {
        plan: "Claude Code",
        quotas: {
          "session (5h)": { used: 40, total: 100, remaining: 60, remainingPercentage: 60, resetAt: later },
          weekly: { used: 10, total: 100, remaining: 90, remainingPercentage: 90 },
        },
      },
    },
    // A free tier has nothing to pace, and an account that only spoke is kept
    // in `raw`, drawn as its own named section, and counted as not reporting.
    { connection: { id: "c2", provider: "kiro" }, usage: { quotas: { monthly: { unlimited: true } } } },
    { connection: { id: "c3", provider: "codex" }, usage: { message: "re-authorize this connection" } },
  ]);
  assert.equal(snap.status, "subscription");
  // The window keeps its own name; the account is said once, on the group the
  // page draws as a heading. The plan rides along in the group's name, which is
  // what a provider card puts in its badge.
  assert.deepEqual(
    snap.windows.map((w) => [w.id, w.label, w.group, Math.round(w.usedPercent)]),
    [
      ["c1:session (5h)", "session (5h)", "Max account · Claude Code", 40],
      ["c1:weekly", "weekly", "Max account · Claude Code", 10],
    ],
  );
  assert.equal(snap.windows[0].resetsAt, later);
  // A percentage of 100 is already the reading; saying 40/100 beside it is the
  // same number twice.
  assert.equal(snap.windows[0].cap, null);
  assert.equal(snap.planName, "9Router · 1 account (2 not reporting)");
  assert.match(snap.raw, /re-authorize/);
});

test("foldNineRouterQuota names every account the gateway holds, in its own order", () => {
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "claude", name: "Work Max", priority: 1 },
      usage: { quotas: { weekly: { remainingPercentage: 10 } } },
    },
    // Turned off: no windows, and its state is the gateway's, not a provider's.
    { connection: { id: "c2", provider: "opencode-go", name: "gmail", isActive: false }, usage: {} },
    { connection: { id: "c3", provider: "kiro", name: "Account 1" }, usage: { message: "Kiro quota API rejected the current token." } },
  ]);
  assert.deepEqual(
    snap.accounts.map((a) => [a.id, a.name, a.provider, a.windows, a.disabled, a.usedPercent]),
    [
      ["c1", "Work Max", "claude", 1, false, 90],
      ["c2", "gmail", "opencode-go", 0, true, null],
      ["c3", "Account 1", "kiro", 0, false, null],
    ],
  );
  // A silent account carries the words for why — the gateway's own where it
  // left one, and the adapter's plainest statement where it did not.
  assert.equal(snap.accounts[2].state, "Kiro quota API rejected the current token.");
  assert.equal(snap.accounts[1].state, null);
  assert.equal(snap.planName, "9Router · 1 account (1 off, 1 not reporting)");
});

/* ── Many accounts: one section each, never pooled ──
   A five-hour window is a *different* five hours per account, and a Max
   subscription and a GLM key are not interchangeable capacity. Pooling was
   tried and removed: "60% across four accounts" hides both the account that is
   exhausted and the one nobody has touched. */

test("foldNineRouterQuota keeps every account's window its own", () => {
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "claude", name: "Work Max" },
      usage: { quotas: { "session (5h)": { remainingPercentage: 10, resetAt: later } } },
    },
    {
      connection: { id: "c2", provider: "claude", name: "Personal Max" },
      usage: { quotas: { "session (5h)": { remainingPercentage: 70, resetAt: soon } } },
    },
  ]);
  assert.deepEqual(
    snap.windows.map((w) => [w.group, Math.round(w.usedPercent), w.resetsAt]),
    [
      ["Work Max", 90, later],
      ["Personal Max", 30, soon],
    ],
  );
  assert.equal(snap.planName, "9Router · 2 accounts");
});

test("foldNineRouterQuota hands the renderer one join key, plan and all", () => {
  // The window's `group` is the account's `group`, never its bare `name`: the
  // group carries the plan, and a card that matched on the name would find no
  // tiles for exactly the accounts the gateway could describe best.
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "claude", name: "Work Max" },
      usage: {
        plan: "Claude Code",
        quotas: { "session (5h)": { remainingPercentage: 60 } },
      },
    },
  ]);
  assert.equal(snap.accounts[0].name, "Work Max");
  assert.equal(snap.accounts[0].plan, "Claude Code");
  assert.equal(snap.accounts[0].group, "Work Max · Claude Code");
  assert.equal(snap.windows[0].group, snap.accounts[0].group);
});

test("foldNineRouterQuota disambiguates the account's name, not just its group", () => {
  // Two logins the gateway shows one name for: the heading has to say which is
  // which, because there is no second line for the group string to hide in.
  const snap = foldNineRouterQuota([
    { connection: { id: "c1", provider: "claude", name: "Claude" }, usage: { quotas: { weekly: { remainingPercentage: 50 } } } },
    { connection: { id: "c2", provider: "claude", name: "Claude" }, usage: { quotas: { weekly: { remainingPercentage: 20 } } } },
  ]);
  assert.deepEqual(snap.accounts.map((a) => a.name), ["Claude", "Claude (2)"]);
  assert.deepEqual(snap.accounts.map((a) => a.group), ["Claude", "Claude (2)"]);
  assert.deepEqual(snap.windows.map((w) => w.group), ["Claude", "Claude (2)"]);
});

test("foldNineRouterQuota leaves the accounts in the gateway's own priority order", () => {
  const snap = foldNineRouterQuota([
    { connection: { id: "c1", name: "First" }, usage: { quotas: { weekly: { remainingPercentage: 95 } } } },
    { connection: { id: "c2", name: "Second" }, usage: { quotas: { weekly: { remainingPercentage: 5 } } } },
  ]);
  // Fullest-first would put "Second" on top and scramble the one fact a
  // fallback chain has to show: which account is serving now.
  assert.deepEqual(snap.windows.map((w) => w.group), ["First", "Second"]);
  assert.deepEqual(snap.accounts.map((a) => a.id), ["c1", "c2"]);
});

test("foldNineRouterQuota keeps the amounts an account counted", () => {
  const snap = foldNineRouterQuota([
    { connection: { id: "c1", provider: "glm" }, usage: { quotas: { weekly: { used: 300, total: 1200 } } } },
  ]);
  const [window] = snap.windows;
  assert.deepEqual([Math.round(window.usedPercent), window.used, window.cap], [25, 300, 1200]);
});

test("foldNineRouterQuota derives the spend from an absolute remainder", () => {
  // GitHub reports `used`/`total`; Kiro and Qoder report a `remaining` that is
  // the same kind of number as the total. Reading the second as a percentage is
  // how an account with 1500 of 2000 left came out at 2000% used.
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "kiro" },
      usage: { quotas: { monthly: { used: 500, total: 2000, remaining: 1500 } } },
    },
  ]);
  const [window] = snap.windows;
  assert.deepEqual([Math.round(window.usedPercent), window.used, window.cap], [25, 500, 2000]);
});

test("foldNineRouterQuota reads a normalized percentage pair as a percentage", () => {
  // The other half of the same rule: `total: 100, remaining: 30` is 30%
  // remaining, not 0.3% — and the pair is not shown as amounts, because 70/100
  // is the percentage said twice.
  const snap = foldNineRouterQuota([
    { connection: { id: "c1", provider: "codex" }, usage: { quotas: { weekly: { used: 70, total: 100, remaining: 30 } } } },
  ]);
  const [window] = snap.windows;
  assert.deepEqual([Math.round(window.usedPercent), window.used, window.cap], [70, 70, null]);
});

test("foldNineRouterQuota never draws two accounts as one section", () => {
  // Same display name, two logins: a shared group string would merge their bars
  // into one heading, which is the one thing `group` must not do.
  const snap = foldNineRouterQuota([
    { connection: { id: "c1", provider: "claude", name: "Claude" }, usage: { quotas: { weekly: { remainingPercentage: 50 } } } },
    { connection: { id: "c2", provider: "claude", name: "Claude" }, usage: { quotas: { weekly: { remainingPercentage: 20 } } } },
  ]);
  assert.deepEqual(snap.windows.map((w) => w.group), ["Claude", "Claude (2)"]);
  assert.notEqual(snap.windows[0].id, snap.windows[1].id);
  // Both are still their own account, with their own id.
  assert.deepEqual(snap.accounts.map((a) => a.id), ["c1", "c2"]);
});

/* ── The gateway's own names ──
   9Router's dashboard never draws a handler's raw quota key: it runs the same
   body through `parseQuotaData` first. Reading `/api/usage/<id>` without that
   is how one account came out labelled `spark_weekly` here and "Spark
   (Weekly)" there, and how one Antigravity login drew a dozen bars. */

test("foldNineRouterQuota names a window the way the gateway's own page does", () => {
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "codex", name: "Codex" },
      usage: {
        quotas: {
          session: { used: 30, total: 100, remaining: 70 },
          spark_weekly: { used: 10, total: 100, remaining: 90 },
        },
      },
    },
  ]);
  assert.deepEqual(snap.windows.map((w) => w.label), ["5h", "Spark (Weekly)"]);
});

test("foldNineRouterQuota draws one Antigravity bar per family, at the family's worst", () => {
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "antigravity", name: "AG" },
      usage: {
        quotas: {
          "gemini-3-pro": { remainingPercentage: 80 },
          /* The model that runs out first is what gates the account, so it is
             the one the family's bar shows. */
          "gemini-3-flash": { remainingPercentage: 20 },
          "claude-sonnet-4-6": { remainingPercentage: 50 },
          gemini_weekly: { remainingPercentage: 90, displayName: "Weekly" },
        },
      },
    },
  ]);
  // The two families first, then the weekly allowance and the rest — the order
  // upstream's own `parseQuotaData` pushes them in.
  assert.deepEqual(
    snap.windows.map((w) => [w.label, Math.round(w.usedPercent)]),
    [
      ["Gemini (Flash / Pro)", 80],
      ["Claude (Sonnet / Opus)", 50],
      ["Weekly", 10],
    ],
  );
});

test("foldNineRouterQuota keeps an Antigravity image model as its own row", () => {
  // Upstream does not fold an image model into a family — `includes("image")`
  // takes it out of both — so dropping it would lose a bar the gateway's own
  // page draws.
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "antigravity", name: "AG" },
      usage: {
        quotas: {
          "gemini-3.1-flash-image": { remainingPercentage: 40, displayName: "Gemini 3.1 Flash Image" },
          "gemini-3-flash": { remainingPercentage: 90 },
        },
      },
    },
  ]);
  assert.deepEqual(
    snap.windows.map((w) => w.label),
    ["Gemini (Flash / Pro)", "Gemini 3.1 Flash Image"],
  );
});

test("foldNineRouterQuota keeps an unlimited window, with the spend it counted", () => {
  // Vercel's credits body, verbatim: a spend against no stated budget. Dropping
  // it — as this adapter used to — is how a pay-as-you-go account read as having
  // no windows at all, and the balance beside it was thrown away.
  const snap = foldNineRouterQuota([
    {
      connection: { id: "c1", provider: "vercel-ai-gateway", name: "28082026" },
      usage: {
        plan: "Pay-as-you-go",
        quotas: {
          "Used (USD)": { used: 5, total: 0, remaining: 0, remainingPercentage: 100, unlimited: true },
          "Remaining (USD)": { used: -0.0082592, total: 5, remaining: -0.0082592, remainingPercentage: -0.165184, unlimited: false },
        },
      },
    },
  ]);
  assert.equal(snap.windows[0].unlimited, true);
  assert.equal(snap.windows[0].cap, null);
  assert.equal(snap.windows[0].used, 5);
  // The second is a real window over the monthly allocation, and its spend is
  // what the `remainingPercentage` complement says — the balance has gone
  // fractionally negative, so the allocation is spent.
  assert.equal(snap.windows[1].unlimited, false);
  assert.equal(snap.windows[1].cap, 5);
  assert.equal(Math.round(snap.windows[1].usedPercent), 100);
});

test("foldNineRouterQuota counts the accounts it could not read, not just the quiet ones", () => {
  const snap = foldNineRouterQuota(
    [{ connection: { id: "c1", name: "First" }, usage: { quotas: { weekly: { remainingPercentage: 95 } } } }],
    4,
  );
  assert.equal(snap.planName, "9Router · 1 account (+3 not shown)");
});

test("foldNineRouterQuota reads a gateway with nothing linked as no plan, never 0%", () => {
  const snap = foldNineRouterQuota([]);
  assert.deepEqual(snap.windows, []);
  assert.deepEqual(snap.accounts, []);
  assert.equal(snap.status, "api-key");
});
/* ── The probe must not race the runtime's own OAuth refresh ──
   `claude -p /usage` is a second copy of the CLI on the same credentials file as
   the live agent child. Both refreshing at once burns the rotating refresh token
   and logs the account out, so while one of ours is alive the probe yields to the
   cache. A profile provider's reading is an HTTP call and never yields. */
const defaultProfile = { id: "default:claude-code", name: "Default", agents: {}, baseUrl: "", apiKey: "", models: [], defaultModel: "", smallModel: "", logoUrl: "" } as never;

/* A login file in a scratch dir, pointed at through the row's own `dirEnv` —
   the same door a profile's CLAUDE_CONFIG_DIR opens. */
const loginDir = mkdtempSync(join(tmpdir(), "daedalus-login-"));
const writeLogin = (expiresAt: number) =>
  writeFileSync(join(loginDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt } }));
const probeAgent = (id: string, login = true) =>
  ({
    id,
    name: id,
    command: id,
    args: [],
    env: { TEST_LOGIN_DIR: loginDir },
    quotaProbe: {
      kind: "claude-cli",
      command: "claude",
      args: [],
      login: login ? { dirEnv: "TEST_LOGIN_DIR", dir: ".nowhere", file: ".credentials.json", expiresAt: "claudeAiOauth.expiresAt" } : null,
    },
  }) as never;

await test("the agent probe is held back while that runtime is live and its login may refresh", async () => {
  writeLogin(Date.now() + 60_000);
  setRuntimeLiveCheck(() => false);
  assert.equal(await probeHeldBack(defaultProfile, probeAgent("claude-code")), false);
  setRuntimeLiveCheck((id) => id === "claude-code");
  assert.equal(await probeHeldBack(defaultProfile, probeAgent("claude-code")), true);
  // Another runtime's login is another file; it is not what is at risk.
  assert.equal(await probeHeldBack(defaultProfile, probeAgent("codex")), false);
  setRuntimeLiveCheck(() => false);
});

await test("a live runtime does not hold the probe back while its token has hours left", async () => {
  setRuntimeLiveCheck(() => true);
  writeLogin(Date.now() + 6 * 3_600_000);
  assert.equal(await probeHeldBack(defaultProfile, probeAgent("claude-code")), false);
  // No `login` on the row means no way to tell, and the old caution stands.
  assert.equal(await probeHeldBack(defaultProfile, probeAgent("claude-code", false)), true);
  setRuntimeLiveCheck(() => false);
});

await test("a profile provider's reading is never held back — it races nothing", async () => {
  setRuntimeLiveCheck(() => true);
  assert.equal(
    await probeHeldBack({ ...(zaiProfile() as object), usage: { kind: "zai" } } as never, probeAgent("claude-code")),
    false,
  );
  setRuntimeLiveCheck(() => false);
});

test("parseClaudeUsage reads a subscription report with no limit lines as a failure", () => {
  const snap = parseClaudeUsage(
    claudeEnvelope("You are currently using your subscription to power your Claude Code usage\n\nLast 24h · 2281 requests"),
  );
  assert.equal(snap.status, "error");
  assert.deepEqual(snap.windows, []);
  assert.match(snap.error ?? "", /without its limits/);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed: ${failures.join(", ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
