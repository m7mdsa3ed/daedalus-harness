/**
 * Loopback ports for the processes the harness starts beside itself —
 * code-server, a project's dev server, an OpenCode sidecar.
 *
 * A port is bound and released rather than guessed: the window between the
 * release and the child's own bind is small enough that a collision is a
 * failed start the user can retry, and picking a number out of a range
 * collides far more often than that. (Was copied into ide.ts and
 * dev-server.ts; lives here once now.)
 */
import { createServer } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Ports ready before they are asked for. `SessionManager.start` is
 * synchronous — it is called from the queue drain, which runs in the tick a
 * turn ends — and binding a socket is not, so a spawn that needs a port takes
 * one from here and the pool refills behind it. Empty only in the first
 * moments after boot; a caller handed `undefined` spawns without the feature
 * that needed the port and says so, rather than waiting.
 */
export class PortPool {
  private readonly ports: number[] = [];
  private filling = false;
  private readonly size: number;

  constructor(size = 3) {
    this.size = size;
    this.fill();
  }

  take(): number | undefined {
    const port = this.ports.shift();
    this.fill();
    return port;
  }

  private fill(): void {
    if (this.filling || this.ports.length >= this.size) return;
    this.filling = true;
    void (async () => {
      try {
        while (this.ports.length < this.size) this.ports.push(await freePort());
      } catch {
        /* the next take() tries again */
      } finally {
        this.filling = false;
      }
    })();
  }
}
