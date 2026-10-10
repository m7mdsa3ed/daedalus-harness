import { performance } from "node:perf_hooks";

/* `performance.now()` counts from the start of the process, so the first mark is
   the cost of loading every module and the later ones are the phases of the boot
   in order. One line each, in the server log, so "why was it down for N seconds"
   is read off the log instead of guessed at. `t` is since process start; the
   restart a client sees also includes pm2's stop and fork, which precede it. */
let last = 0;

export function mark(label: string): void {
  const now = performance.now();
  console.log(`[boot] +${Math.round(now - last)}ms ${label} (t=${Math.round(now)}ms)`);
  last = now;
}
