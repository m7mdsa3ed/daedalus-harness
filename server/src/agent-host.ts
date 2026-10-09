/* Per-agent host (dtach/conmon style). Launched detached by the server so an
   agent outlives a server restart. Node stdlib only: it imports nothing from
   the rest of the server, because it must keep working while the server is
   being replaced.

     node dist/agent-host.js --id <id> --dir <dir>      spec on stdin, one JSON line:
                                                         {command,args,env,cwd}

   Files: <dir>/<id>.sock (0600) and <dir>/<id>.json (0600) {pid,hostPid,spec,startedAt[,error][,exited:{code,signal,at}]}
   (written last, once the socket listens, so its existence means "ready"). `spec` is
   REDACTED: {command,args,cwd,envKeys:[names]} — env values (API keys) stay in memory.

   Protocol, ndJSON both ways, one client at a time (a new one replaces the old):
     client -> host  {t:"attach",fromOffset}  {t:"write",data}  {t:"kill",signal}  {t:"stderr"}
     host -> client  {t:"attached",lossy,firstOffset,nextOffset}   then buffered lines >= fromOffset
                     {t:"data",offset,line}   (replay and live alike)
                     {t:"stderr",data,replay:true}  the tail, once on attach (and on a {t:"stderr"} request)
                     {t:"stderr",data}              each new chunk, live, while attached
                     {t:"exit",code,signal[,error]}
   Offsets number the child's stdout LINES from 0. `lossy` = lines the client asked
   for (>= fromOffset) were dropped from the ring. */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";

interface Spec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}
interface Line {
  offset: number;
  line: string;
  size: number;
}

const argv = process.argv.slice(2);
const flag = (n: string): string => {
  const i = argv.indexOf(n);
  if (i < 0 || !argv[i + 1]) throw new Error(`missing ${n}`);
  return argv[i + 1]!;
};
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

const id = flag("--id");
const dir = flag("--dir");
const MAX_BYTES = num(process.env.DAEDALUS_AGENT_HOST_BUFFER_BYTES, 8 * 1024 * 1024) || 8 * 1024 * 1024;
const LINGER_MS = num(process.env.DAEDALUS_AGENT_HOST_LINGER_MS, 60_000);
const GRACE_MS = 200;
const STDERR_TAIL = 64 * 1024;
const sockPath = join(dir, `${id}.sock`);
const jsonPath = join(dir, `${id}.json`);

async function readSpec(): Promise<Spec> {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) {
    s += c;
    const i = s.indexOf("\n");
    if (i >= 0) {
      s = s.slice(0, i);
      break;
    }
  }
  return JSON.parse(s) as Spec;
}

async function main(): Promise<void> {
  process.on("SIGHUP", () => {});
  process.on("SIGPIPE", () => {});
  const spec = await readSpec();
  const startedAt = Date.now();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is ignored when the dir already exists

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.stdin.on("error", () => {});

  // ---- ring of numbered stdout lines ---------------------------------------
  // ponytail: head index + occasional splice; a deque if the ring is ever huge.
  let lines: Line[] = [];
  let head = 0;
  let bytes = 0;
  let next = 0;
  let partial = "";
  const firstOffset = (): number => (lines.length > head ? lines[head]!.offset : next);

  let client: Socket | null = null;
  let attached = false;
  // ponytail: no backpressure to a slow client; its socket buffers in memory.
  const send = (s: Socket | null, o: unknown): void => {
    if (s && !s.destroyed) s.write(JSON.stringify(o) + "\n");
  };

  const pushLine = (line: string): void => {
    const l: Line = { offset: next++, line, size: Buffer.byteLength(line) + 1 };
    lines.push(l);
    bytes += l.size;
    // the newest line is always kept, even when it alone exceeds the bound
    while (bytes > MAX_BYTES && lines.length - head > 1) bytes -= lines[head++]!.size;
    if (head > 1024 && head > lines.length / 2) {
      lines = lines.slice(head);
      head = 0;
    }
    if (attached) send(client, { t: "data", offset: l.offset, line });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    partial += chunk;
    let i: number;
    while ((i = partial.indexOf("\n")) >= 0) {
      pushLine(partial.slice(0, i));
      partial = partial.slice(i + 1);
    }
  });

  let errTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => {
    errTail = (errTail + c).slice(-STDERR_TAIL);
    if (attached) send(client, { t: "stderr", data: c });
  });

  // ---- exit and cleanup ------------------------------------------------------
  let exited: { code: number | null; signal: string | null; error?: string } | null = null;
  let cleanupTimer: NodeJS.Timeout | undefined;
  // <id>.json is written once the socket listens, and rewritten when the child
  // exits (so list() sees `finished` with no client attached) or fails to start.
  let ready = false;
  const writeInfo = (): void => {
    if (!ready) return;
    const tmp = `${jsonPath}.tmp`;
    const info = {
      pid: child.pid ?? null,
      hostPid: process.pid,
      spec: { command: spec.command, args: spec.args, cwd: spec.cwd, envKeys: Object.keys(spec.env ?? {}) },
      startedAt,
      ...(exited?.error ? { error: exited.error } : {}),
      ...(exited ? { exited: { code: exited.code, signal: exited.signal, at: Date.now() } } : {}),
    };
    writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
    renameSync(tmp, jsonPath);
  };
  const cleanupIn = (ms: number): void => {
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      rmSync(sockPath, { force: true });
      rmSync(jsonPath, { force: true });
      process.exit(0);
    }, ms);
  };
  const finish = (e: NonNullable<typeof exited>): void => {
    if (exited) return;
    exited = e;
    writeInfo();
    if (partial) pushLine(partial);
    partial = "";
    if (attached) {
      send(client, { t: "exit", ...e });
      cleanupIn(GRACE_MS);
    } else {
      // nobody to tell: linger so the server can still read the tail and the code
      cleanupIn(LINGER_MS);
    }
  };
  child.on("close", (code, signal) => finish({ code, signal }));
  child.on("error", (err) => {
    if (child.pid === undefined) finish({ code: null, signal: null, error: err.message });
  });

  // ---- socket ------------------------------------------------------------------
  const onMsg = (s: Socket, m: Record<string, unknown>): void => {
    switch (m.t) {
      case "attach": {
        const from = Math.min(Math.max(0, Math.floor(Number(m.fromOffset)) || 0), next);
        send(s, { t: "attached", lossy: from < firstOffset(), firstOffset: firstOffset(), nextOffset: next });
        for (let i = head; i < lines.length; i++) {
          const l = lines[i]!;
          if (l.offset >= from) send(s, { t: "data", offset: l.offset, line: l.line });
        }
        send(s, { t: "stderr", data: errTail, replay: true });
        attached = true;
        if (exited) {
          send(s, { t: "exit", ...exited });
          cleanupIn(GRACE_MS);
        }
        break;
      }
      case "write":
        if (typeof m.data === "string" && !exited) child.stdin.write(m.data);
        break;
      case "kill":
        try {
          child.kill((typeof m.signal === "string" ? m.signal : "SIGTERM") as NodeJS.Signals);
        } catch {
          /* unknown signal name */
        }
        break;
      case "stderr":
        send(s, { t: "stderr", data: errTail, replay: true });
        break;
    }
  };

  const srv = createServer((sock) => {
    if (client) client.destroy();
    client = sock;
    attached = false;
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        try {
          onMsg(sock, JSON.parse(l) as Record<string, unknown>);
        } catch {
          /* a malformed line is dropped */
        }
      }
    });
    sock.on("close", () => {
      if (client === sock) {
        client = null;
        attached = false;
      }
    });
  });
  rmSync(sockPath, { force: true });
  const prev = process.umask(0o177);
  await new Promise<void>((res, rej) => {
    srv.once("error", rej);
    srv.listen(sockPath, res);
  });
  process.umask(prev);

  ready = true;
  writeInfo();
}

main().catch((err) => {
  process.stderr.write(`agent-host: ${err instanceof Error ? err.message : String(err)}\n`);
  rmSync(sockPath, { force: true });
  process.exit(1);
});
