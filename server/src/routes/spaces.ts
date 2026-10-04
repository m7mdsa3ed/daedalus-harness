import type { Hono } from "hono";
import {
  SpaceInputSchema,
  createSpace,
  deleteSpace,
  listSpaces,
  onlySpace,
  projectsInSpace,
  updateSpace,
} from "../spaces.js";
import { crud } from "./helpers.js";

/** Spaces — a named scope above projects (spaces.ts). The list is what the
    client's switcher draws; the project routes take the space id. */
export function spaceRoutes(app: Hono): void {
  app.get("/api/spaces", async (c) => c.json(await listSpaces()));
  const spaceCrud = crud(SpaceInputSchema);
  app.post("/api/spaces", spaceCrud.create(createSpace));
  app.put("/api/spaces/:id", spaceCrud.update(updateSpace));
  /* Deleting a space refuses while it still holds anything — the same bargain
     `DELETE /api/profiles/:id` makes with a live thread, so nothing the row
     scopes is orphaned by a cascade. The last space is refused too: the app has
     to have somewhere for a project to land. */
  app.delete("/api/spaces/:id", async (c) => {
    const id = c.req.param("id");
    if (await onlySpace(id)) {
      return c.json({ error: "This is the only space — the app needs at least one." }, 409);
    }
    const count = await projectsInSpace(id);
    if (count > 0) {
      return c.json(
        { error: `${count} project${count === 1 ? "" : "s"} still live in this space. Move or delete them first.` },
        409,
      );
    }
    return (await deleteSpace(id)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
}
