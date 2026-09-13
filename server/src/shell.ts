/**
 * Running one line of shell and capturing what it printed.
 *
 * This is the captured counterpart of `terminals.ts`: a `!` command in the
 * composer is not a session anybody types into, so it is run to completion and
 * its output goes into the transcript (`_daedalus/shell`) rather than down a
 * PTY socket. Everything that *makes* a shell — the login shell and its PATH,
 * which is why `pnpm` is found (see `shellFor`) — is shared with the terminal
 * module deliberately, so a helper behaves the same whichever door ran it.
 *
 * It never rejects. A command that exits non-zero, one that is not installed,
 * and one that ran out of time are all normal outcomes of a `!` line, and each
 * is something the row has to *say* rather than an error the route throws.
 */
import { execFile } from "node:child_process";
import { shellFor } from "./terminals.js";

export interface ShellRun {
  /** stdout, then stderr, joined the way a terminal would have shown them. */
  output: string;
  /** The exit code, or null when the process could not be started at all (a
      missing shell, a permissions error) — a different fact from a run that
      started and failed. */
  exitCode: number | null;
  /** The shell was killed at the timeout — `output` is what it printed first. */
  timedOut: boolean;
}

/** Long enough for a build or a test run, short enough that a line that will
    never exit (a dev server) does not hold the request for ever. */
const TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 1024 * 1024;

export function runShellLine(opts: {
  cwd: string;
  command: string;
  env?: Record<string, string>;
}): Promise<ShellRun> {
  const { file, args } = shellFor(opts.command);
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      },
      (error, stdout, stderr) => {
        const err = error as
          | (NodeJS.ErrnoException & { killed?: boolean; code?: number | string })
          | null;
        /* The two streams arrive apart though a terminal interleaves them, so
           they are joined in the order a shell prints them — the output, then
           the diagnostics. A newline is added only when the halves would weld
           together, which is the one way prose could be misread. */
        const output =
          stdout && stderr && !stdout.endsWith("\n") ? `${stdout}\n${stderr}` : `${stdout}${stderr}`;
        resolve({
          output,
          /* A number is the exit code; a string code is a spawn failure
             (`ENOENT`, `EACCES`) with no process behind it to have exited. */
          exitCode: !error ? 0 : typeof err?.code === "number" ? err.code : null,
          timedOut: Boolean(err?.killed),
        });
      },
    );
  });
}
