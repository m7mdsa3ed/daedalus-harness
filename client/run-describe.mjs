import { build } from "esbuild"
import { writeFileSync } from "fs"

const entry = `/var/www/daedalus-harness/client/describe-airlock.ts`
writeFileSync(entry, `
import { describeCommand } from "./src/lib/tools/describe"
const cmds = process.argv.slice(2)
for (const c of cmds) {
  console.log(JSON.stringify(c), "=>", JSON.stringify(describeCommand(c)))
}
`)
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "/var/www/daedalus-harness/client/describe-run.mjs",
})
