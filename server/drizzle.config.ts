import { defineConfig } from "drizzle-kit";

/*
 * Migrations are generated (`pnpm db:generate`) and committed, then applied at
 * boot by `migrate()` in src/db/index.ts. Nothing runs drizzle-kit in
 * production — `push` would let a schema edit reach a user's database without
 * a reviewable SQL file in between.
 *
 * DAEDALUS_DATA_DIR moves the database, and the default matches config.ts.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: `${process.env.DAEDALUS_DATA_DIR ?? "./data"}/daedalus.db`,
  },
});
