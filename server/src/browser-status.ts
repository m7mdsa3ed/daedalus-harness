/*
 * Is there a Chrome on this server, and which one.
 *
 * Modelled on `agent-status.ts`: both answers are facts about *this machine
 * right now*, so they are cached in memory with a TTL and never in the
 * database. Where the binary is comes from `DAEDALUS_CHROME` when it is set,
 * else puppeteer's own `computeSystemExecutablePath` for stable Chrome (reached
 * through `puppeteer.executablePath("chrome")`, which is that call). The
 * version is **measured, never parsed**: it is `browser.version()` from a real
 * launch — either the probe below or the first project browser that comes up
 * (`recordBrowserVersion`), whichever happens first.
 */
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

import type { BrowserStatusResponse } from "./browser-protocol.js";

/** Long enough that the settings page and every panel open do not each launch
    a probe; short enough that an `apt install google-chrome-stable` shows up. */
export const BROWSER_STATUS_TTL_MS = 5 * 60_000;
/** A probe launch that has not answered by now is reported, not waited on. */
const PROBE_TIMEOUT_MS = 20_000;

let cached: (BrowserStatusResponse & { checkedAt: number }) | null = null;
let inflight: Promise<BrowserStatusResponse> | null = null;

/** Where Chrome is, or why there is none. Synchronous apart from the
    puppeteer lookup, which only computes a path. */
export async function locateChrome(): Promise<{ path: string } | { reason: string }> {
  const override = process.env.DAEDALUS_CHROME?.trim();
  let path: string;
  if (override) {
    path = override;
  } else {
    try {
      path = await puppeteer.executablePath("chrome");
    } catch (error) {
      return { reason: `no stable Chrome found (${error instanceof Error ? error.message : String(error)}); set DAEDALUS_CHROME` };
    }
  }
  try {
    if (!statSync(path).isFile()) return { reason: `${path} is not a file` };
    accessSync(path, constants.X_OK);
  } catch {
    return { reason: override ? `DAEDALUS_CHROME=${path} is not an executable file` : `${path} is not an executable file` };
  }
  return { path };
}

/** A project browser launched: its version is the measurement, so the status
    needs no probe of its own after the first launch. */
export function recordBrowserVersion(executablePath: string, version: string): void {
  cached = { available: true, version, executablePath, checkedAt: Date.now() };
}

/** The status route's answer. `refresh` skips the TTL. */
export function getBrowserStatus({ refresh = false } = {}): Promise<BrowserStatusResponse> {
  if (!refresh && cached && Date.now() - cached.checkedAt < BROWSER_STATUS_TTL_MS) return Promise.resolve(strip(cached));
  if (inflight) return inflight;
  inflight = measure()
    .then((status) => {
      cached = { ...status, checkedAt: Date.now() };
      return status;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** For tests: forget what was measured. */
export function evictBrowserStatus(): void {
  cached = null;
}

const strip = ({ checkedAt: _, ...status }: BrowserStatusResponse & { checkedAt: number }): BrowserStatusResponse =>
  status;

async function measure(): Promise<BrowserStatusResponse> {
  const found = await locateChrome();
  if ("reason" in found) return { available: false, reason: found.reason };
  // A throwaway profile, so the probe never contends for a project's lock.
  const profile = mkdtempSync(join(tmpdir(), "daedalus-chrome-probe-"));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: found.path,
      headless: true,
      pipe: true,
      userDataDir: profile,
      timeout: PROBE_TIMEOUT_MS,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    return { available: true, version: await browser.version(), executablePath: found.path };
  } catch (error) {
    return { available: false, reason: `Chrome at ${found.path} did not start: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await browser?.close().catch(() => browser?.process()?.kill("SIGKILL"));
    rmSync(profile, { recursive: true, force: true });
  }
}
