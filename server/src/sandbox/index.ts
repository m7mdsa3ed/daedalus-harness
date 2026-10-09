import { DirectSandbox } from "./direct.js";
import { HostedSandbox } from "./hosted.js";
import type { Sandbox } from "./types.js";

/** The one place agent processes are started from. `DAEDALUS_SANDBOX=hosted` keeps
    agents alive across a server restart; read once, at import. */
export const sandbox: Sandbox = process.env.DAEDALUS_SANDBOX === "hosted" ? new HostedSandbox() : new DirectSandbox();
export type { Handle, HandleInfo, Sandbox, SpawnSpec } from "./types.js";
/** Whether agents outlive this server (hosted): shutdown then detaches them and
    keeps their `agent_processes` rows instead of killing. */
export const durable = sandbox instanceof HostedSandbox;
