// Run: pnpm test:loopback-secret
import "./require-temp-data.js";
import assert from "node:assert/strict";
import test from "node:test";
import { _forgetSecretForTest, derive } from "../src/loopback-secret.js";

test("same secret -> same key across a restart; purpose and session separate keys", () => {
  const a = derive("gw");
  _forgetSecretForTest();
  assert.equal(derive("gw"), a);
  assert.notEqual(derive("mx"), a);
  assert.notEqual(derive("ph", "s1"), derive("ph", "s2"));
  assert.match(a, /^[0-9a-f]{48}$/);
});
