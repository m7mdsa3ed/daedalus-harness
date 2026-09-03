import { execSync } from "child_process"
const cmds = process.argv.slice(2)
const ts = `
import { describeCommand } from "./src/lib/tools/describe"
const cmds = ${JSON.stringify(cmds)}
for (const c of cmds) console.log(JSON.stringify(c), "=>", JSON.stringify(describeCommand(c)))
`
const { writeFileSync } = await import("fs")
writeFileSync("/var/www/daedalus-harness/client/describe-ts-entry.ts", ts)
