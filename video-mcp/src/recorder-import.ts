import { parseStoryboard, type Storyboard } from "./storyboard.js";

// Recorder step types that change nothing on screen; dropped rather than rejected.
const IGNORED = new Set(["close", "emulateNetworkConditions"]);

/**
 * Chrome DevTools Recorder export ({title, steps} or a bare steps array) to a storyboard:
 * one step per recorder step (s1, s2...) with empty narration and the step itself as "do".
 * setViewport sets the storyboard viewport instead of becoming a step; the first navigate's
 * origin becomes baseUrl and same-origin navigates turn relative. Throws on a shape it cannot read.
 */
export function importRecorder(raw: unknown, name: string): Storyboard {
  const obj = Array.isArray(raw) ? { steps: raw } : (raw as { title?: unknown; steps?: unknown } | null);
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.steps)) throw new Error('not a Recorder export: expected {"title", "steps": [...]} or a steps array');

  let viewport: { width: number; height: number } | undefined;
  let origin: string | undefined;
  const actions: Record<string, unknown>[] = [];

  for (const [i, s] of obj.steps.entries()) {
    if (!s || typeof s !== "object" || typeof (s as { type?: unknown }).type !== "string") throw new Error(`recorder step ${i + 1} has no "type"`);
    const step = { ...(s as Record<string, unknown>) };
    const type = step.type as string;
    if (IGNORED.has(type)) continue;
    if (type === "setViewport") {
      viewport ??= { width: Math.round(Number(step.width)), height: Math.round(Number(step.height)) };
      continue;
    }
    if (type === "navigate") {
      try {
        const u = new URL(String(step.url));
        origin ??= u.origin;
        if (u.origin === origin) step.url = u.pathname + u.search + u.hash;
      } catch {} // already relative or odd: leave it for the capture to resolve or warn about
    }
    actions.push(step);
  }
  if (!actions.length) throw new Error("the Recorder export has no steps to run");

  return parseStoryboard({
    version: 1,
    title: typeof obj.title === "string" && obj.title ? obj.title : name,
    ...(origin ? { baseUrl: origin } : {}),
    ...(viewport ? { viewport } : {}),
    steps: actions.map((a, i) => ({ id: `s${i + 1}`, say: "", do: a })),
  });
}
