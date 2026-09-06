/**
 * Refuse to run when `DAEDALUS_DATA_DIR` is unset.
 *
 * The tests that import this one delete rows — `db.delete(sessionsTable)` and
 * friends — from whatever database `db/index.js` opens, and with no
 * `DAEDALUS_DATA_DIR` that is `server/data/daedalus.db`: the install. The npm
 * scripts all set it; running the file directly (`tsx test/backup.test.ts`)
 * does not, and that is exactly how a real install lost every project, thread
 * and journal row it had, leaving the fixtures behind in their place.
 *
 * Imported FIRST, before `db/index.js`, because ESM evaluates imports in the
 * order they are declared — a check written as a statement in the test body
 * would run after the connection is already open.
 */
if (!process.env.DAEDALUS_DATA_DIR) {
  console.error(
    "refusing to run: this test empties tables, and with no DAEDALUS_DATA_DIR that is server/data/daedalus.db.\n" +
      "Run it through its npm script (pnpm test:backup, pnpm test:boards, …), or set DAEDALUS_DATA_DIR to a temp directory.",
  );
  process.exit(1);
}
