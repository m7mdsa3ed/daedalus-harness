/* electron-builder, carrying the harness's one version. The root manifest is
   what the server and the About row report; client/package.json is a workspace
   placeholder, and electron-updater compares versions — without this every
   build would claim 0.1.0 and never see itself as old. A script, not a
   `$(node -p …)` in package.json, because that does not expand under cmd.exe.

   The update feed is `DAEDALUS_UPDATE_URL`, a generic provider (a directory of
   latest*.yml and installers). It is added here rather than written into
   package.json as `${env.DAEDALUS_UPDATE_URL}` because electron-builder fails
   the whole build on an unset env macro, and a from-CLI publish cannot be
   nulled out again; unset, the build has no app-update.yml and main.cjs logs
   the failed checks and moves on. Extra arguments (`--win`) pass through.

   A gitignored client/.env may carry it instead, and an exported value wins:
   one build made without the feed ships no app-update.yml, and every install
   it reaches stops updating for good. */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

const envFile = new URL("../.env", import.meta.url)
if (existsSync(envFile)) process.loadEnvFile(envFile)

const require = createRequire(import.meta.url)
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

const args = [require.resolve("electron-builder/cli.js"), `-c.extraMetadata.version=${version}`]
const feed = process.env.DAEDALUS_UPDATE_URL
if (feed) args.push("-c.publish.provider=generic", `-c.publish.url=${feed}`)
args.push(...process.argv.slice(2))

const { status } = spawnSync(process.execPath, args, { stdio: "inherit" })
process.exit(status ?? 1)
