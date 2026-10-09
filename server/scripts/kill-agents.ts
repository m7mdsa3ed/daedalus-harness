/*
 * `pnpm pm2:kill-agents` — the "stop everything" command for DAEDALUS_SANDBOX=hosted.
 *
 * Under a hosted sandbox `pm2 stop`/`restart` leaves every agent running (that
 * is the point). This ends them: every agent host found on disk is told to kill
 * its child, and every saved adopt state is dropped. Run it with the server
 * stopped (or accept that its threads revive on their next send).
 */
import { killHost } from "../src/adopt-boot.js";
import { dropProcessState, loadProcessStates } from "../src/adopt-state.js";
import { HostedSandbox } from "../src/sandbox/hosted.js";

const sb = new HostedSandbox();
const hosts = await sb.list();
await Promise.all(hosts.map((h) => killHost(sb, h.id)));
const rows = await loadProcessStates();
await Promise.all(rows.map((r) => dropProcessState(r.hostId)));
console.log(`ended ${hosts.length} agent host(s), dropped ${rows.length} saved state(s)`);
process.exit(0);
