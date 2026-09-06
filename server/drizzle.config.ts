import { defineConfig } from "drizzle-kit";

/*
 * The schema is pushed, never migrated: `pnpm db:push` after a schema.ts
 * change (src/db/index.ts does it itself for a database that has never been
 * opened). There are no migration files.
 *
 * DAEDALUS_DATA_DIR moves the database, and the default matches config.ts.
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
