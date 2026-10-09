/* HostedSandbox: output through the Handle, detach + reattach from the saved offset
   (a second instance = a server restart), kill, list, stale cleanup, lossy.
   Run: tsx test/hosted-sandbox.test.ts */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedSandbox } from "../src/sandbox/hosted.js";
import type { Handle } from "../src/sandbox/types.js";

const dir = mkdtempSync(join(tmpdir(), "hs-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await sleep(15);
  }
}
// prints argv[1] lines, then echoes stdin as `echo:<line>`; `quit` exits 3
const AGENT = `
for (let i = 0; i < +process.argv[1]; i++) console.log('line' + i);
console.error('boot');
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'quit') process.exit(3);
  if (l === 'big') { for (let i = 0; i < 150; i++) process.stderr.write('e'.repeat(1023) + '\\n'); console.log('bigdone'); return; }
  console.log('echo:' + l);
});
setInterval(() => {}, 1e6);
`;
const spec = (n: number) => ({ command: process.execPath, args: ["-e", AGENT, String(n)], env: {}, cwd: dir });
function collect(h: Handle): string[] {
  const lines: string[] = [];
  let buf = "";
  h.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  return lines;
}

const s1 = new HostedSandbox({ dir });
const h = await s1.spawn(spec(2));
const got = collect(h);
await until(() => got.length === 2);
assert.deepEqual(got, ["line0", "line1"]);
h.stdin.write("hi\n");
await until(() => got.length === 3);
assert.equal(got[2], "echo:hi");
assert.equal(h.offset, 3);
assert.ok(h.running);

// detach: the agent keeps running; lines produced meanwhile are buffered
const saved = h.offset;
h.detach();
assert.equal((await s1.list()).length, 1);
const s2 = new HostedSandbox({ dir });
const [info] = await s2.list();
assert.ok(info && info.pid && info.startedAt && info.spec);
const h2 = await s2.attach(info.id, saved);
const got2 = collect(h2);
h2.stdin.write("again\n");
await until(() => got2.length === 1);
assert.deepEqual(got2, ["echo:again"]);
assert.equal(h2.lossy, false);

// a second detach/attach receives exactly what was produced while away
h2.detach();
const h3 = await s2.attach(info.id, 0);
const got3 = collect(h3);
await until(() => got3.length === 4);
assert.deepEqual(got3, ["line0", "line1", "echo:hi", "echo:again"]);

// stderr tail reaches the handle once, on attach (the replay of "boot")
const err: string[] = [];
h3.stderr.setEncoding("utf8").on("data", (d: string) => err.push(d));
await until(() => err.join("") === "boot\n");

// live stderr: >64 KB (tail rotates) arrives exactly once, as it is written
h3.stdin.write("big\n");
await until(() => got3.includes("bigdone"));
await until(() => err.join("").length === 5 + 150 * 1024);
await sleep(100);
assert.equal(err.join("").length, 5 + 150 * 1024);

// kill: exit surfaces, files go away
let exitSeen: unknown;
h3.on("exit", (code, sig) => (exitSeen = [code, sig]));
h3.kill("SIGKILL");
assert.equal(await h3.exited, null);
assert.deepEqual(exitSeen, [null, "SIGKILL"]);
assert.equal(h3.running, false);
assert.match(err.join(""), /boot/);
await until(() => !existsSync(join(dir, `${info.id}.sock`)));

// the file holds no env values, only key names; modes are private
const sec = await s1.spawn({ ...spec(0), env: { API_KEY: "sk-very-secret" } });
const raw = readFileSync(join(dir, `${sec.id}.json`), "utf8");
assert.ok(!raw.includes("sk-very-secret"));
assert.deepEqual(JSON.parse(raw).spec.envKeys, ["API_KEY"]);
assert.ok(!JSON.stringify(await s1.list()).includes("sk-very-secret"));
assert.equal(statSync(join(dir, `${sec.id}.json`)).mode & 0o777, 0o600);
assert.equal(statSync(dir).mode & 0o777, 0o700);
sec.kill("SIGKILL");
await sec.exited;

// a host that accepts and never answers: attach rejects within the bound
const stubPath = join(dir, "stub.sock");
const stub = createServer(() => {}).listen(stubPath);
await new Promise((r) => stub.once("listening", r));
const t1 = Date.now();
await assert.rejects(new HostedSandbox({ dir, attachTimeoutMs: 300 }).attach("stub", 0), /did not answer attach within 300ms/);
assert.ok(Date.now() - t1 < 3000);
stub.close();

// exit code via the agent itself
const h4 = await s1.spawn(spec(0));
h4.stdin.write("quit\n");
assert.equal(await h4.exited, 3);
await until(() => !existsSync(join(dir, `${h4.id}.json`)));

// stale: a .json whose host is dead is dropped; live ones stay
const live = await s1.spawn(spec(0));
const liveId = (await s1.list())[0]!.id;
writeFileSync(join(dir, "dead.json"), JSON.stringify({ pid: 1, hostPid: 2 ** 22 + 12345, spec: spec(0), startedAt: 1 }));
writeFileSync(join(dir, "dead.sock"), "");
const ids = (await s1.list()).map((i) => i.id);
assert.deepEqual(ids, [liveId]);
assert.ok(!existsSync(join(dir, "dead.json")) && !existsSync(join(dir, "dead.sock")));

// lossy: tiny buffer drops old lines; attach from 0 says so and starts at the first kept
process.env.DAEDALUS_AGENT_HOST_BUFFER_BYTES = "100";
const lossy = await new HostedSandbox({ dir }).spawn(spec(50));
await sleep(300);
lossy.detach();
const l2 = await new HostedSandbox({ dir }).attach((await new HostedSandbox({ dir }).list()).find((i) => i.id !== liveId)!.id, 0);
assert.equal(l2.lossy, true);
assert.ok(l2.offset > 0);

// a child that fails to start fails spawn fast, with its error
const t0 = Date.now();
await assert.rejects(new HostedSandbox({ dir }).spawn({ command: "/nonexistent/agent-bin", args: [], env: {}, cwd: dir }), /ENOENT/);
assert.ok(Date.now() - t0 < 5000);

// list() carries hostPid; a child that exited unattended is `finished`
assert.equal(typeof (await s1.list()).find((i) => i.id === liveId)!.hostPid, "number");
const quick = await new HostedSandbox({ dir }).spawn({ command: process.execPath, args: ["-e", "console.log(1)"], env: {}, cwd: dir });
quick.detach();
await until(() => existsSync(join(dir, `${quick.id}.json`)));
for (let i = 0; i < 400 && !(await s1.list()).find((x) => x.id === quick.id)?.finished; i++) await sleep(15);
assert.equal((await s1.list()).find((x) => x.id === quick.id)?.finished, true);
const qa = await new HostedSandbox({ dir }).attach(quick.id, 0);
assert.equal(await qa.exited, 0);

live.kill("SIGKILL");
l2.kill("SIGKILL");
await Promise.all([live.exited, l2.exited]);
rmSync(dir, { recursive: true, force: true });
console.log("hosted-sandbox ok");
