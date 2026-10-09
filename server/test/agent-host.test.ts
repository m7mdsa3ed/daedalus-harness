/* agent-host: buffering, reattach-from-offset, overflow, write, kill, survival of
   the launcher, cleanup. The "agent" is a tiny node child. Run: tsx test/agent-host.test.ts */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = fileURLToPath(new URL("../src/agent-host.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ah-"));
const hostPids: number[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 8000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await sleep(15);
  }
}

// prints N lines, echoes stdin lines, `quit` exits 3; argv[2]=="exit" exits 0 after printing
const AGENT = `
const n = +process.argv[1];
for (let i = 0; i < n; i++) console.log('line' + i);
if (process.argv[2] === 'exit') process.exit(0);
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  if (l === 'quit') process.exit(3);
  console.log('echo:' + l);
});
setInterval(() => {}, 1e6);
`;
const agent = (n: number, ...rest: string[]) => ({
  command: process.execPath,
  args: ["-e", AGENT, String(n), ...rest],
  env: {},
  cwd: dir,
});

const hostArgs = (id: string) => ["--import", "tsx", HOST, "--id", id, "--dir", dir];

async function start(id: string, spec: object, env: Record<string, string> = {}): Promise<void> {
  const p = spawn(process.execPath, hostArgs(id), { detached: true, stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, ...env } });
  p.stdin.end(JSON.stringify(spec) + "\n");
  p.unref();
  await ready(id);
}
async function ready(id: string): Promise<void> {
  await until(() => existsSync(join(dir, `${id}.json`)));
  hostPids.push(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")).hostPid);
}

type Msg = { t: string; [k: string]: any };
async function client(id: string) {
  const s = connect(join(dir, `${id}.sock`));
  await new Promise<void>((res, rej) => s.once("connect", res).once("error", rej));
  const msgs: Msg[] = [];
  let closed = false;
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      msgs.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  s.on("close", () => (closed = true));
  s.on("error", () => {});
  return {
    msgs,
    send: (o: object) => s.write(JSON.stringify(o) + "\n"),
    close: () => s.destroy(),
    isClosed: () => closed,
    wait: async (p: (m: Msg) => boolean) => {
      await until(() => msgs.some(p));
      return msgs.find(p)!;
    },
    data: () => msgs.filter((m) => m.t === "data").map((m) => [m.offset, m.line]),
  };
}

// 1. output is buffered with no client; attach from 0 replays all of it
await start("a", agent(5));
await sleep(300);
const c1 = await client("a");
c1.send({ t: "attach", fromOffset: 0 });
const att = await c1.wait((m) => m.t === "attached");
assert.deepEqual([att.lossy, att.firstOffset, att.nextOffset], [false, 0, 5]);
await until(() => c1.data().length === 5);
assert.deepEqual(c1.data(), [0, 1, 2, 3, 4].map((i) => [i, `line${i}`]));

// 2. a new client replaces the old; reattach from an offset replays exactly the rest
const c2 = await client("a");
await until(() => c1.isClosed());
c2.send({ t: "attach", fromOffset: 3 });
await c2.wait((m) => m.t === "attached");
await sleep(150);
assert.deepEqual(c2.data(), [[3, "line3"], [4, "line4"]]);

// 3. write reaches stdin, answer streams live at the next offset
c2.send({ t: "write", data: "hi\n" });
await c2.wait((m) => m.t === "data" && m.line === "echo:hi");
assert.equal(c2.data().at(-1)![0], 5);
c2.send({ t: "stderr" });
assert.equal((await c2.wait((m) => m.t === "stderr")).data, "");

// 4. child exit: client told, then files and host are gone
c2.send({ t: "write", data: "quit\n" });
const ex = await c2.wait((m) => m.t === "exit");
assert.deepEqual([ex.code, ex.signal], [3, null]);
await until(() => !existsSync(join(dir, "a.sock")) && !existsSync(join(dir, "a.json")));

// 5. overflow drops oldest lines and sets lossy
await start("b", agent(50), { DAEDALUS_AGENT_HOST_BUFFER_BYTES: "100" });
await sleep(300);
const c3 = await client("b");
c3.send({ t: "attach", fromOffset: 0 });
const ov = await c3.wait((m) => m.t === "attached");
assert.equal(ov.lossy, true);
assert.equal(ov.nextOffset, 50);
assert.ok(ov.firstOffset > 0 && ov.firstOffset < 50);
await until(() => c3.data().length === 50 - ov.firstOffset);
assert.equal(c3.data()[0]![0], ov.firstOffset);
const c4 = await client("b");
c4.send({ t: "attach", fromOffset: ov.firstOffset });
assert.equal((await c4.wait((m) => m.t === "attached")).lossy, false);

// 6. kill
c4.send({ t: "kill", signal: "SIGKILL" });
const k = await c4.wait((m) => m.t === "exit");
assert.deepEqual([k.code, k.signal], [null, "SIGKILL"]);
await until(() => !existsSync(join(dir, "b.json")));

// 7. the host survives its launcher exiting
const LAUNCH = `
const { spawn } = require('child_process');
const [host, spec] = [process.argv[1], process.argv[2]];
const p = spawn(process.execPath, JSON.parse(host), { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
p.stdin.end(spec + '\\n'); p.unref(); setTimeout(() => process.exit(0), 300);
`;
const l = spawn(process.execPath, ["-e", LAUNCH, JSON.stringify(hostArgs("c")), JSON.stringify(agent(2))], { stdio: "ignore" });
await new Promise((r) => l.once("exit", r));
await ready("c");
const hp = JSON.parse(readFileSync(join(dir, "c.json"), "utf8")).hostPid;
process.kill(hp, 0); // throws if dead
const c5 = await client("c");
c5.send({ t: "attach", fromOffset: 0 });
await until(() => c5.data().length === 2);
c5.send({ t: "kill", signal: "SIGTERM" });
await c5.wait((m) => m.t === "exit");

// 8. a child that exits with nobody attached is lingered for: replay, then exit
await start("d", agent(3, "exit"), { DAEDALUS_AGENT_HOST_LINGER_MS: "5000" });
await sleep(400);
assert.ok(existsSync(join(dir, "d.json")));
const c6 = await client("d");
c6.send({ t: "attach", fromOffset: 1 });
await c6.wait((m) => m.t === "exit");
assert.deepEqual(c6.data(), [[1, "line1"], [2, "line2"]]);
const dj = JSON.parse(readFileSync(join(dir, "d.json"), "utf8"));
assert.equal(dj.exited.code, 0);
assert.ok(dj.exited.at > 0 && !("error" in dj));
await until(() => !existsSync(join(dir, "d.sock")));

// 9. a child that fails to start: .json carries `error`, the socket still says `exit`
await start("e", { command: "/nonexistent/agent-bin", args: [], env: {}, cwd: dir }, { DAEDALUS_AGENT_HOST_LINGER_MS: "5000" });
assert.match(JSON.parse(readFileSync(join(dir, "e.json"), "utf8")).error, /ENOENT/);
const c7 = await client("e");
c7.send({ t: "attach", fromOffset: 0 });
assert.match((await c7.wait((m) => m.t === "exit")).error, /ENOENT/);
await until(() => !existsSync(join(dir, "e.json")));

for (const pid of hostPids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
rmSync(dir, { recursive: true, force: true });
console.log("agent-host: ok");
process.exit(0);
