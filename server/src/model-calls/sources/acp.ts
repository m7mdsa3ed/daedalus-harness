import type { CallSource } from "../index.js";

/** The degenerate door: the runtime sends `_daedalus/model_call` itself (our
    agent's `trace.ts`), the bridge forwards it whole and the thread's `emit`
    files it. Always attaches; nothing to watch, nothing to stop. */
export const acpSource: CallSource = {
  kind: "acp",
  attach: async () => ({ stop() {} }),
};
