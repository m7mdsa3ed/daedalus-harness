/**
 * Put the fake agent in the agent picker of a real install — `pnpm fake:agent`.
 *
 * The tests spawn `fake-agent.mjs` themselves (each writes its own
 * `agents.json` into its own `DAEDALUS_DATA_DIR`), so nothing outside them
 * knows the script exists. Driving the transcript by hand needs a row in the
 * real database, and there is no create route for one: `POST /api/agents` does
 * not exist, deliberately — an agent row is a contract with a binary somebody
 * else ships, so the API only lets you edit and reset the rows a release
 * seeded. This writes the row directly instead of widening that.
 *
 * It is not in `DEFAULT_AGENTS` and must not be: seeding is what every install
 * gets, and a test double is not something to ship into other people's pickers.
 * Idempotent — run it again after moving the repo and the command is rewritten.
 * Delete it from Settings › Agents when you are done.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { agents, db } from "../src/db/index.js";

const script = join(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs");
const row = {
  id: "fake-echo",
  name: "Fake (transcript samples)",
  command: process.execPath,
  args: [script],
  env: {},
  /* The persona door, so a thread's persona reaches it the way a real agent's
     does — the fake records the `_meta` it was handed, which is the only way to
     see that half working without a credentialed runtime. */
  personaVia: "acp-meta" as const,
  seededVersion: 0,
};

db.insert(agents)
  .values(row)
  .onConflictDoUpdate({ target: agents.id, set: { command: row.command, args: row.args } })
  .run();

const saved = db.select().from(agents).where(eq(agents.id, row.id)).get();
console.log(`[fake] ${saved?.name} → ${saved?.command} ${(saved?.args ?? []).join(" ")}`);
console.log("[fake] restart the server, then pick it on a new thread (profile: Default).");
console.log('[fake] say `scene:` in the composer for the list of samples.');
