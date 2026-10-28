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
import { LOGIN_PROBE_ENV, loginMethods, parseAuthStatus } from "../src/agent-status.js";
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

test("NO_BROWSER is the probe's alone", () => {
  assert.deepEqual(LOGIN_PROBE_ENV, { NO_BROWSER: "1" });
  assert.equal(process.env.NO_BROWSER, undefined, "the probe env must never be written to process.env");
});
