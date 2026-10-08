import assert from "node:assert/strict";
import { closeDb, describeTables, readOnlyQuery } from "../src/db/index.js";
assert.deepEqual((await readOnlyQuery("select 1 as a;", 5)).rows, [[1]]);
await assert.rejects(readOnlyQuery("select 1); commit; drop table sessions; --", 5));
await assert.rejects(readOnlyQuery("with x as (delete from sessions returning 1) select * from x", 5), /read-only/);
assert.deepEqual(Object.keys(await describeTables("sessions")), ["sessions"]);
await closeDb();
console.log("sql ok");
