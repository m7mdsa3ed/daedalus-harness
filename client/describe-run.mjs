import { build } from "./node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/lib/main.js"
import { writeFileSync } from "fs"
const entry = "/var/www/daedalus-harness/client/describe-ts-entry.ts"
const cmds = JSON.stringify(process.argv.slice(2))
writeFileSync(entry, `
import { describeCommand } from "./src/lib/tools/describe"
const cmds = ${cmds}
for (const c of cmds) console.log(JSON.stringify(c), "=>", JSON.stringify(describeCommand(c)))
`)
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: "/var/www/daedalus-harness/client/describe-ts-entry.mjs", logLevel: "silent" })
