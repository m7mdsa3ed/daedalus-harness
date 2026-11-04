// Self-check for the login half of agent-status.ts: which ACP auth methods the
// harness offers as a login (a credential-taking one never is), and how
// claude-agent-acp's identity push reads (`kind: "none"` is logged out, a
// missing payload is "cannot tell"). And that the probe-only env stays off a
// thread's spawn.
// Run: pnpm test:agent-login
// agent-status reads the quota fallback, which imports the database.
import "./require-temp-data.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOGIN_PROBE_ENV,
  advertisesAuthStatus,
  authenticatedFrom,
  loginMethods,
  parseAuthStatus,
  readAuthStatus,
} from "../src/agent-status.js";
import type * as acp from "../src/acp.js";

/* The methods the two shipped adapters send under NO_BROWSER, as read from
   their builds (claude-agent-acp 0.89, codex-acp). */
const claudeRemote: acp.AuthMethod[] = [
  { id: "claude-login", name: "Log in with Claude", type: "terminal", args: ["--cli"] },
];
const codex: acp.AuthMethod[] = [
  { id: "api-key", name: "API Key", _meta: { "api-key": { provider: "openai" } } },
  { id: "chat-gpt-device-code", name: "ChatGPT (device code)", description: "Sign in with a code" },
  { id: "gateway", name: "Custom model gateway", _meta: { gateway: { protocol: "openai" } } },
];

test("a terminal method is a terminal login", () => {
  assert.deepEqual(loginMethods(claudeRemote), [
    { id: "claude-login", name: "Log in with Claude", description: null, kind: "terminal" },
  ]);
});

test("credential-taking methods are a profile's, never a login", () => {
  assert.deepEqual(
    loginMethods(codex).map((m) => [m.id, m.kind]),
    [["chat-gpt-device-code", "agent"]],
  );
});

test("no methods is no logins", () => {
  assert.deepEqual(loginMethods(undefined), []);
});

test("the identity push: none is logged out, anything else in, silence unknown", () => {
  assert.equal(parseAuthStatus({ authStatus: { kind: "none" } }), false);
  assert.equal(parseAuthStatus({ authStatus: { kind: "account" } }), true);
  assert.equal(parseAuthStatus({ authStatus: { kind: "api_key" } }), true);
  assert.equal(parseAuthStatus({}), null);
  assert.equal(parseAuthStatus(null), null);
});

/* A v1.29 `initialize` answer as claude-agent-acp 0.100 / codex-acp 2.5 give
   it, and the same with the door withheld. */
const initWithStatus: acp.InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, auth: { status: {} }, sessionCapabilities: { list: {} } },
  authMethods: [],
};

test("auth/status is asked only of an agent whose initialize advertised auth.status", () => {
  assert.equal(advertisesAuthStatus(initWithStatus), true);
  assert.equal(advertisesAuthStatus({ ...initWithStatus, agentCapabilities: { auth: { status: null } } }), false);
  assert.equal(advertisesAuthStatus({ ...initWithStatus, agentCapabilities: { auth: {} } }), false);
  assert.equal(advertisesAuthStatus({ ...initWithStatus, agentCapabilities: {} }), false);
  assert.equal(advertisesAuthStatus({ protocolVersion: 1, authMethods: [] } as acp.InitializeResponse), false);
  assert.equal(advertisesAuthStatus(null), false);
});

test("the auth/status answer: the five states, accounts as display only, junk as no reading", () => {
  const reading = readAuthStatus({
    state: "authenticated",
    accounts: [
      { label: "Claude Max", active: true, name: "Noah", email: "noah@example.com", organization: "Mawared" },
      { label: "OpenAI API key" },
      { active: true }, // no label: not an account the schema allows
    ],
  });
  assert.deepEqual(reading, {
    state: "authenticated",
    accounts: [
      { label: "Claude Max", active: true, name: "Noah", email: "noah@example.com", organization: "Mawared" },
      { label: "OpenAI API key", active: null, name: null, email: null, organization: null },
    ],
  });
  assert.deepEqual(readAuthStatus({ state: "unauthenticated" }), { state: "unauthenticated", accounts: [] });
  assert.deepEqual(readAuthStatus({ state: "not_required" }), { state: "not_required", accounts: [] });
  assert.deepEqual(readAuthStatus({ state: "unknown" }), { state: "unknown", accounts: [] });
  // Reserved and vendor values read as unknown, as the schema says they MUST.
  assert.equal(readAuthStatus({ state: "_vendor_pending" })?.state, "unknown");
  assert.equal(readAuthStatus({ state: "expired" })?.state, "unknown");
  assert.equal(readAuthStatus({}), null);
  assert.equal(readAuthStatus({ state: 3 }), null);
  assert.equal(readAuthStatus(null), null);
});

test("what the reading says for `authenticated`: in, out, not needed is in, unknown says nothing", () => {
  assert.equal(authenticatedFrom({ state: "authenticated", accounts: [] }), true);
  assert.equal(authenticatedFrom({ state: "not_required", accounts: [] }), true);
  assert.equal(authenticatedFrom({ state: "unauthenticated", accounts: [] }), false);
  assert.equal(authenticatedFrom({ state: "unknown", accounts: [] }), null);
  assert.equal(authenticatedFrom(null), null);
  // The probe's order of precedence: protocol, then the adapter's push, then the CLI.
  const pushed = parseAuthStatus({ authStatus: { kind: "none" } });
  assert.equal(authenticatedFrom({ state: "authenticated", accounts: [] }) ?? pushed, true);
  assert.equal(authenticatedFrom({ state: "unknown", accounts: [] }) ?? pushed, false);
});

test("NO_BROWSER is the probe's alone", () => {
  assert.deepEqual(LOGIN_PROBE_ENV, { NO_BROWSER: "1" });
  assert.equal(process.env.NO_BROWSER, undefined, "the probe env must never be written to process.env");
});
