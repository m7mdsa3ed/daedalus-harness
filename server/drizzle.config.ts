import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./src/config.js";

/*
 * The schema is pushed, never migrated: `pnpm db:push` runs the schema
 * diff directly, with no backup first. A fresh
 * database is initialized by src/db/index.ts. There are no migration files.
 *
 * Which server is `config.ts`'s answer and not a second one written here:
 * `databaseUrl()` reads DATABASE_URL, then `data/config.json`, then the
 * default — so a push and the server it is pushing for can never disagree
 * about which database they mean. Unlike the SQLite file this replaced, push
 * needs a *reachable* server — `pnpm db:push` on a machine where Postgres is
 * down fails at connect, not at the first statement.
 *
 * Push is not one transaction. If it dies partway, the statements behind the
 * failure never apply and every later run stops at the same place; the repair
 * is to make that statement legal by hand (`psql "$DATABASE_URL"`) and push
 * again. Unlike SQLite, Postgres can ALTER a constraint in place, so a
 * nullability or default change is no longer a table rebuild — the old
 * `__new_<table>` failure mode is gone with the dialect.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  /* The full-text index over the journal is maintained by hand (src/db/index.ts
     creates it at boot, src/search.ts writes it): it carries a generated
     tsvector column and a GIN index, neither of which is worth modelling in
     schema.ts for a table nothing joins to by drizzle. Hidden from push so
     push does not drop what it cannot see declared — but `tablesFilter` hides
     *tables*, and a `bigserial` on a hidden table leaves behind a sequence
     that push does see, does not recognise and tries to DROP, which Postgres
     refuses because the hidden column still defaults from it. That is why the
     table carries no surrogate key at all (db/index.ts). */
  tablesFilter: ["!session_events_fts"],
  dbCredentials: {
    url: databaseUrl(),
  },
});
