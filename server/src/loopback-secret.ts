/**
 * One persisted secret behind every loopback credential an agent process is
 * handed (`/gw`, `/mx`, `/ph`, `/wf`, `/hm`, `/rt` keys). An agent
 * outlives a server restart, so what the old server gave it must still open
 * the new one: keys are `derive(purpose)`, HMACs of this file, not per-boot
 * randomness. Unguessable without the file; never logged, never exported by
 * backup (it is a file under the gitignored `data/`, not a row).
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

let secret: Buffer | null = null;

function load(): Buffer {
  if (secret) return secret;
  const path = join(DATA_DIR, "loopback-secret");
  try {
    secret = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    if (secret.length !== 32) throw new Error("bad length");
  } catch {
    // flag "wx" so two processes racing at first boot cannot each keep their own
    try {
      writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    } catch {
      /* lost the race, or a corrupt file: fall through and re-read / overwrite */
    }
    try {
      secret = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
      if (secret.length !== 32) throw new Error("bad length");
    } catch {
      writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
      secret = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
    }
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort (non-POSIX filesystems) */
  }
  return secret;
}

/** Stable hex key for a purpose, optionally scoped to one session. */
export function derive(purpose: string, sessionId?: string): string {
  return createHmac("sha256", load())
    .update(sessionId === undefined ? purpose : `${purpose}\0${sessionId}`)
    .digest("hex")
    .slice(0, 48);
}

/** Test seam: forget the cached secret so the next call re-reads the file,
    which is what a restart does. */
export function _forgetSecretForTest(): void {
  secret = null;
}
