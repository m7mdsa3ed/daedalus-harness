import type { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../sessions.js";
import { availableTtsProviders, listConfiguredTtsProviders, saveTtsProvider } from "../video/providers.js";
import { VideoDocumentSchema } from "../video/schema.js";
import { downloadVideoRender, generateVideoSpeech, getVideoRender, queueVideoRender, readVideo, saveVideo } from "../video/service.js";

const TtsSettingsSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  voice: z.string().min(1),
});

export function videoRoutes(app: Hono, deps: { sessions: SessionManager }): void {
  const { sessions } = deps;

  app.get("/api/video/providers", async (c) => c.json({ available: availableTtsProviders(), configured: await listConfiguredTtsProviders() }));

  app.put("/api/video/providers/:provider", async (c) => {
    const parsed = TtsSettingsSchema.safeParse({ ...(await c.req.json().catch(() => ({}))), provider: c.req.param("provider") });
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      return c.json(await saveTtsProvider(parsed.data));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/sessions/:id/video", async (c) => {
    try {
      return c.json(await readVideo(c.req.param("id")));
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, status as 404 | 500);
    }
  });

  app.put("/api/sessions/:id/video", async (c) => {
    const parsed = VideoDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    try {
      if (!sessions.get(c.req.param("id"))) return c.json({ error: "no such thread" }, 404);
      return c.json(await saveVideo(c.req.param("id"), parsed.data));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/sessions/:id/video/speech", async (c) => {
    try {
      return c.json(await generateVideoSpeech(c.req.param("id"), await c.req.json().catch(() => ({}))));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/sessions/:id/video/renders", async (c) => {
    try {
      return c.json(await queueVideoRender(c.req.param("id")), 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/api/sessions/:id/video/renders/:renderId/preview", async (c) => {
    try {
      const { bytes, size } = await getVideoRender(c.req.param("id"), c.req.param("renderId"));
      const range = c.req.header("range");
      const match = range?.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) return new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Length": String(size), "Accept-Ranges": "bytes" } });
      const start = match[1] ? Number(match[1]) : 0;
      const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      const part = bytes.subarray(start, end + 1);
      return new Response(part, { status: 206, headers: { "Content-Type": "video/mp4", "Content-Length": String(part.length), "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes" } });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });

  app.get("/api/sessions/:id/video/renders/:renderId", async (c) => {
    try {
      const bytes = await downloadVideoRender(c.req.param("id"), c.req.param("renderId"));
      return new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="video-${c.req.param("renderId")}.mp4"` } });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });
}
