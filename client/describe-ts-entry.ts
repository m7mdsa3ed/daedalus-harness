
import { describeCommand } from "./src/lib/tools/describe"
const cmds = []
for (const c of cmds) console.log(JSON.stringify(c), "=>", JSON.stringify(describeCommand(c)))
