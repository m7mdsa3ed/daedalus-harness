import { defineConfig } from "drizzle-kit";

/*
 * The schema is pushed, never migrated: `pnpm db:push` after a schema.ts
 * change (src/db/index.ts does it itself for a database that has never been
 * opened). There are no migration files.
 *
 * DAEDALUS_DATA_DIR moves the database, and the default matches config.ts.
 *
 * If push dies on `no such column: "x"`, it is drizzle recreating a table —
 * SQLite cannot ALTER a constraint, so a nullability or default change is a
 * `__new_<table>` copy — and building the copy's SELECT from the *new* column
 * list rather than the intersection with the old one. Push is not one
 * transaction, so the CREATE lands, the INSERT throws, and every later run
 * dies at the same statement: nothing behind it in the plan ever applies.
 * The repair is to make that SELECT legal, then push again:
 *   sqlite3 data/daedalus.db "DROP TABLE IF EXISTS \`__new_<table>\`;
 *     ALTER TABLE \`<table>\` ADD COLUMN \`x\` <type>;"
 * Nullable adds only — anything NOT NULL wants a default or a backfill first.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  /* The FTS5 index over the journal is a virtual table drizzle cannot model
     (src/search.ts creates it at boot). Left to push, drizzle-kit reads its
     shadow tables as unknown, drops the virtual table with them and then
     crashes on the shadow it has already taken — so it is hidden from push. */
  tablesFilter: ["!session_events_fts*"],
  dbCredentials: {
    url: `${process.env.DAEDALUS_DATA_DIR ?? "./data"}/daedalus.db`,
  },
});
