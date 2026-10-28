// The prewarm registry (src/prewarm.ts): the spawn hash that decides whether a
// warm process may be handed to a thread, and the rules that keep a warm process
// from being a leak — single use, a TTL, and a cap.
//
// What is worth holding here is the refusal: a warm process is only ever the
// process the thread would have started, so a claim whose spec has moved on
// must find nothing and must take the entry with it. Everything else — that a
// real agent answers `initialize` — is a spawn, and a spawn is not this file's
// to test.
// Run: pnpm test:prewarm
import "./require-temp-data.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  PREWARM_MAX,
  PREWARM_TTL_MS,
  __test,
  claim,
  draftPairOf,
  drop,
  prewarm,
  prewarmEnabled,
  specKeyFor,
  sweepPrewarm,
  type PrewarmDeps,
} from "../src/prewarm.js";
import { AcpPool } from "../src/acp-connection.js";
import type { AcpConnection } from "../src/acp-connection.js";
import type { Profile } from "../src/profiles.js";
import type { Project } from "../src/projects.js";
import type { Handle, SpawnSpec } from "../src/sandbox/index.js";

/** A handle with pipes and no process behind it: the registry only listens. */
class StubHandle extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  id = "stub";
  pid = 1;
  running = true;
  exited = new Promise<number | null>(() => {});
  kill(): void {
    this.running = false;
  }
  detach(): void {}
}

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  command: "agent-acp",
  args: ["--stdio"],
  cwd: "/tmp/project",
  env: { A_KEY: "1", B_URL: "https://gw", C_MODEL: "m" },
  ...over,
});

/** One fake connection per spawn: `killed` is how a test reads what the
    registry did to a process it owned. */
interface FakeConn {
  conn: AcpConnection;
  killed: number;
}

/**
 * Install fakes for one test and hand back what they saw. `resolved` replaces
 * the spawn the resolver answers with, `init` replaces the handshake, and
 * `spawned` collects every spec the registry actually spawned — which is how
 * the single-flight test counts processes.
 */
function world(
  over: {
    resolved?: () => SpawnSpec;
    init?: (conn: { killed: number }) => Promise<unknown>;
    spawned?: SpawnSpec[];
  } = {},
): { handles: StubHandle[]; conns: FakeConn[] } {
  const handles: StubHandle[] = [];
  const conns: FakeConn[] = [];
  __test({
    resolve: async () => (over.resolved ? over.resolved() : spec()),
    spawn: async (spawnedSpec) => {
      over.spawned?.push(spawnedSpec);
      const handle = new StubHandle();
      handles.push(handle);
      return handle as unknown as Handle;
    },
    connect: () => {
      const fake: FakeConn = { killed: 0, conn: null as unknown as AcpConnection };
      fake.conn = {
        initialized: over.init ? over.init(fake) : Promise.resolve({}),
        kill: () => {
          fake.killed += 1;
        },
      } as unknown as AcpConnection;
      conns.push(fake);
      return fake.conn;
    },
    timeoutMs: 50,
  });
  return { handles, conns };
}

const profile = { id: "p1", name: "gateway", agents: { daedalus: {} }, models: [] } as unknown as Profile;
const project = { id: "proj", name: "proj", cwd: "/tmp/project" } as unknown as Project;
const warmOne = (draft: string) => prewarm(profile, "daedalus", project, { sessionId: draft });
const KEY = () => specKeyFor(spec());

test("the spawn hash is stable, and env key order is not part of it", () => {
  const a = specKeyFor(spec());
  assert.equal(specKeyFor(spec()), a, "the same spawn hashes the same twice");
  assert.equal(
    specKeyFor(spec({ env: { C_MODEL: "m", A_KEY: "1", B_URL: "https://gw" } })),
    a,
    "the env is sorted, so insertion order cannot make two identical spawns differ",
  );
  // Every input that makes it a different process makes it a different key.
  assert.notEqual(specKeyFor(spec({ command: "other-acp" })), a);
  assert.notEqual(specKeyFor(spec({ args: ["--stdio", "--x"] })), a);
  assert.notEqual(specKeyFor(spec({ cwd: "/tmp/elsewhere" })), a);
  assert.notEqual(specKeyFor(spec({ env: { ...spec().env, C_MODEL: "other" } })), a);
  assert.notEqual(specKeyFor(spec({ env: { A_KEY: "1", B_URL: "https://gw" } })), a, "a dropped var is a different spawn");
  assert.match(a, /^[0-9a-f]{40}$/, "a hash, not the env itself — it holds credentials");
});

test("a warm process is handed over only for the spec it was warmed under", async () => {
  const { conns } = world();
  await warmOne("draft-1");
  const stale = claim("draft-1", specKeyFor(spec({ cwd: "/tmp/elsewhere" })));
  assert.equal(stale, null, "a process warmed under another spawn is never handed out");
  assert.equal(conns[0].killed, 1, "and it is not left running");
  assert.equal(claim("draft-1", KEY()), null, "the entry went with the refusal, so a second claim finds nothing");
});

test("a matching claim gets the connection, once", async () => {
  const { conns } = world();
  await warmOne("draft-2");
  assert.equal(claim("draft-2", KEY()), conns[0].conn, "a matching claim gets the connection");
  assert.equal(claim("draft-2", KEY()), null, "and only once — a draft is single use");
  assert.equal(conns[0].killed, 0, "a claimed process is the thread's now, not ours to kill");
});

test("a claim for a draft that was never warmed is null, not a throw", () => {
  __test({});
  assert.equal(claim("nobody", KEY()), null);
});

test("a sweep inside the TTL leaves it warm", async () => {
  const { conns } = world();
  await warmOne("draft-3");
  sweepPrewarm(Date.now() + PREWARM_TTL_MS - 1);
  assert.equal(conns[0].killed, 0, "still inside its window");
  assert.equal(claim("draft-3", KEY()), conns[0].conn, "and still claimable");
});

test("a sweep past the TTL kills it and forgets it", async () => {
  const { conns } = world();
  await warmOne("draft-4");
  sweepPrewarm(Date.now() + PREWARM_TTL_MS);
  assert.equal(conns[0].killed, 1, "an abandoned draft's process is ended");
  assert.equal(claim("draft-4", KEY()), null, "and nothing is left to claim");
});

test("the cap evicts the oldest and never holds more than PREWARM_MAX", async () => {
  const { conns } = world();
  const drafts = Array.from({ length: PREWARM_MAX + 1 }, (_, i) => `draft-cap-${i}`);
  for (const draft of drafts) {
    await warmOne(draft);
    // The clock picks the oldest, so keep one registration distinguishable
    // from the next even when they land in the same millisecond.
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(conns[0].killed, 1, "the oldest was killed to make room");
  assert.equal(claim(drafts[0], KEY()), null, "and forgotten");
  assert.notEqual(claim(drafts[drafts.length - 1], KEY()), null, "the newest is still warm");
});

test("drop ends this draft's process and leaves the others alone", async () => {
  const { conns } = world();
  await warmOne("draft-5");
  await warmOne("draft-6");
  drop("draft-5");
  drop("draft-5"); // idempotent: a cancel may arrive twice
  assert.equal(conns[0].killed, 1);
  assert.equal(conns[1].killed, 0);
  assert.notEqual(claim("draft-6", KEY()), null);
});

test("a process that exits on its own takes its entry with it", async () => {
  const { handles } = world();
  await warmOne("draft-7");
  handles[0].emit("exit", 1, null);
  assert.equal(claim("draft-7", KEY()), null, "a corpse is not a warm process");
});

test("two keystrokes start one process, not two", async () => {
  const spawned: SpawnSpec[] = [];
  world({ spawned, init: () => new Promise((resolve) => setTimeout(() => resolve({}), 10)) });
  await Promise.all([warmOne("draft-8"), warmOne("draft-8")]);
  assert.equal(spawned.length, 1, "the second keystroke waited on the first's process");
  assert.notEqual(claim("draft-8", KEY()), null, "and it is warm afterwards");
});

test("a handshake that never answers costs a log line and nothing else", async () => {
  const { conns } = world({ init: () => new Promise(() => {}) });
  await warmOne("draft-9");
  assert.equal(claim("draft-9", KEY()), null, "nothing was registered");
  assert.equal(conns[0].killed, 1, "and the process it spawned was ended");
});

test("a spawn that fails is invisible", async () => {
  __test({
    resolve: async () => spec(),
    spawn: async () => {
      throw new Error("ENOENT");
    },
    connect: () => {
      throw new Error("unreachable");
    },
    timeoutMs: 50,
  });
  await warmOne("draft-10");
  assert.equal(claim("draft-10", KEY()), null);
});

test("an agent that cannot resolve its spawn is invisible too", async () => {
  __test({
    resolve: async () => {
      throw new Error("unknown agent: nope");
    },
    spawn: async () => {
      throw new Error("unreachable");
    },
    connect: () => {
      throw new Error("unreachable");
    },
    timeoutMs: 50,
  });
  await warmOne("draft-11");
});

test("prewarm is gated off under a hosted sandbox, and starts nothing", async () => {
  const before = process.env.DAEDALUS_SANDBOX;
  const spawned: SpawnSpec[] = [];
  world({ spawned });
  try {
    process.env.DAEDALUS_SANDBOX = "hosted";
    assert.equal(prewarmEnabled(), false, "boot adoption would resurrect a host with no row naming it");
    await warmOne("draft-12");
    assert.equal(spawned.length, 0, "so nothing is spawned");
    assert.equal(claim("draft-12", KEY()), null);
    process.env.DAEDALUS_SANDBOX = "direct";
    assert.equal(prewarmEnabled(), true, "direct is the default, and a leftover child dies with the server");
  } finally {
    if (before === undefined) delete process.env.DAEDALUS_SANDBOX;
    else process.env.DAEDALUS_SANDBOX = before;
    __test(null);
  }
});

/* ── the draft's answer to the gateway, and the claim that takes it away ──
 *
 * A warmed process is spawned against the draft's own id, so its gateway URL is
 * thread-shaped and the shim must be able to resolve it before any row exists
 * (`gateway-shim.ts`, `setGatewayDraftResolver`). The pair is the whole of that
 * answer, and the rule worth holding is that it never outlives the process: a
 * claim, a drop, an eviction, a sweep and an exit all go through the same
 * `forget`, so a real thread can never be answered from the draft door and a
 * draft can never be answered for a child that is gone.
 */

test("the draft's pair is answerable while the process is warm, and not after a claim", async () => {
  world();
  assert.equal(draftPairOf("draft-pair-1"), undefined, "nothing is answerable before a prewarm");
  await warmOne("draft-pair-1");
  assert.deepEqual(draftPairOf("draft-pair-1"), { profileId: "p1", agentId: "daedalus" }, "the pair a draft spawned under answers for it");
  assert.notEqual(claim("draft-pair-1", KEY()), null);
  assert.equal(draftPairOf("draft-pair-1"), undefined, "a claimed id has a row now, and the draft door must not answer for it");
});

test("a refused claim takes the pair with it, so nothing answers for a dead process", async () => {
  world();
  await warmOne("draft-pair-2");
  assert.equal(claim("draft-pair-2", specKeyFor(spec({ cwd: "/tmp/elsewhere" }))), null);
  assert.equal(draftPairOf("draft-pair-2"), undefined, "a stale process is gone, and so is what answered for it");
});

test("drop, an exit and a sweep each take the pair too", async () => {
  const { handles } = world();
  await warmOne("draft-pair-3");
  drop("draft-pair-3");
  assert.equal(draftPairOf("draft-pair-3"), undefined, "a cancelled draft resolves nothing");

  await warmOne("draft-pair-4");
  handles[handles.length - 1].emit("exit", 1, null);
  assert.equal(draftPairOf("draft-pair-4"), undefined, "a process that ended is not resolved for");

  await warmOne("draft-pair-5");
  sweepPrewarm(Date.now() + PREWARM_TTL_MS);
  assert.equal(draftPairOf("draft-pair-5"), undefined, "and neither is one the TTL ended");
});

test("a pair whose spawn never landed is aged out, not left answering forever", async () => {
  /* A spawn that never returns: `boot` has no entry to register, so the pair is
     the only thing naming this draft, and the sweep is the only clock it has. */
  __test({
    resolve: async () => spec(),
    spawn: () => new Promise(() => {}),
    connect: () => {
      throw new Error("unreachable");
    },
    timeoutMs: 50,
  });
  void warmOne("draft-pair-6");
  await new Promise((r) => setTimeout(r, 5)); // let the resolve settle
  assert.deepEqual(
    draftPairOf("draft-pair-6"),
    { profileId: "p1", agentId: "daedalus" },
    "written before the spawn, because the first request arrives before the answer does",
  );
  sweepPrewarm(Date.now() + PREWARM_TTL_MS);
  assert.equal(draftPairOf("draft-pair-6"), undefined, "and it does not outlive the TTL just because no entry dates it");
});

/* ── A runtime whose threads share one process ──
 *
 * `start` spawns these through the pool, keyed on the spec with the thread's env
 * taken out of it (the env rides `_meta` per session, `AgentDef.sharedProcess`).
 * A process of the draft's own would be one no thread ever asks for, so warming
 * means warming the pool — and nothing is claimable, because `start`'s own
 * `pool.acquire` is what finds it.
 */

/** A pool that answers without a process, recording what was asked of it. */
function poolWorld(init: () => Promise<unknown> = async () => ({})) {
  const asked: { agentId: string; key: string; spec: SpawnSpec | null }[] = [];
  const released: AcpConnection[] = [];
  const killed: number[] = [];
  __test({
    resolve: async () => spec(),
    spawn: async (spawnedSpec) => {
      const handle = new StubHandle();
      lastSpec = spawnedSpec;
      return handle as unknown as Handle;
    },
    connect: () => {
      throw new Error("a shared runtime builds no connection of its own");
    },
    poolAcquire: async (agentId, key, start) => {
      /* Run the spawn the way the real pool does, so the spec it is handed is
         the one under test. */
      await start();
      const entry = { agentId, key, spec: lastSpec };
      asked.push(entry);
      const conn = {
        initialized: init(),
        kill: () => killed.push(1),
      } as unknown as AcpConnection;
      return conn;
    },
    poolRelease: (conn) => released.push(conn),
    timeoutMs: 50,
  });
  return { asked, released, killed };
}

let lastSpec: SpawnSpec | null = null;

test("a shared runtime warms the pool, not a process of the draft's own", async () => {
  const { asked, released, killed } = poolWorld();
  await prewarm(profile, "claude-code", project, { sessionId: "draft-shared-1", shared: true });
  assert.equal(asked.length, 1, "the pool was asked for one process");
  assert.deepEqual(asked[0].spec?.env, {}, "spawned without the thread's env, which rides `_meta` instead");
  assert.equal(asked[0].key, AcpPool.key({ ...spec(), env: {} }), "under the key `start` will ask for");
  assert.equal(claim("draft-shared-1", KEY()), null, "nothing is claimable: the pool is where `start` looks");
  assert.equal(released.length, 1, "handed back with nobody on it, so the pool's idle clock ends it");
  assert.equal(killed.length, 0, "and not killed");
});

test("a shared handshake that never answers ends the process it started", async () => {
  const { released, killed } = poolWorld(() => new Promise(() => {}));
  await prewarm(profile, "claude-code", project, { sessionId: "draft-shared-2", shared: true });
  assert.equal(killed.length, 1, "a process that never answered is not left pooled");
  assert.equal(released.length, 0, "and is never handed back as if it were warm");
});
