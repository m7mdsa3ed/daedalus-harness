/* The one runnable check behind the compatibility gate.

     ../server/node_modules/.bin/tsx --tsconfig tsconfig.app.json src/lib/compat.check.mjs   (from client/)

   `--tsconfig` because the `@daedalus/compat` path lives in tsconfig.app.json.
*/
import assert from "node:assert"

import { compatOf } from "./compat.ts"

const client = { api: 3, minServerApi: 2 }

// A server from before versioning sends no numbers: it is API 0.
assert.equal(compatOf({}, { api: 1, minServerApi: 0 }), "ok")
assert.equal(compatOf({}, client), "server-old")

assert.equal(compatOf({ api: 2, minClientApi: 2 }, client), "ok")
assert.equal(compatOf({ api: 1, minClientApi: 0 }, client), "server-old")
assert.equal(compatOf({ api: 5, minClientApi: 4 }, client), "client-old")
// The server being too old is said first: updating the client would not help.
assert.equal(compatOf({ api: 1, minClientApi: 9 }, client), "server-old")

console.log("compat: ok")
