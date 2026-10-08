import { z } from "zod";

export const VideoSceneSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(200).default(""),
  narration: z.string().max(4000).default(""),
  durationSeconds: z.number().min(1).max(30).default(5),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#17211e"),
  audioFile: z.string().regex(/^[0-9a-f-]+\.mp3$/).optional(),
});

export const VideoDocumentSchema = z.object({
  title: z.string().max(200).default("Untitled video"),
  width: z.union([z.literal(1280), z.literal(1920), z.literal(1080)]).default(1280),
  height: z.union([z.literal(720), z.literal(1080), z.literal(1920)]).default(720),
  scenes: z.array(VideoSceneSchema).min(1).max(20).default([
    { id: "scene-1", title: "A new story", narration: "", durationSeconds: 5, background: "#17211e" },
  ]).refine((scenes) => scenes.reduce((total, scene) => total + scene.durationSeconds, 0) <= 180, "Total duration must be 180 seconds or less."),
});

export type VideoScene = z.infer<typeof VideoSceneSchema>;
export type VideoDocument = z.infer<typeof VideoDocumentSchema>;

export const TtsSynthesisSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  sceneId: z.string().min(1).max(80),
});
