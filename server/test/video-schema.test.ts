import assert from "node:assert/strict";
import { VideoDocumentSchema } from "../src/video/schema.js";

const valid = {
  title: "Launch story",
  width: 1280,
  height: 720,
  scenes: [
    { id: "intro", title: "Hello", narration: "Welcome", durationSeconds: 5, background: "#17211e" },
    { id: "end", title: "Goodbye", narration: "", durationSeconds: 5, background: "#293b4a" },
  ],
};

assert.equal(VideoDocumentSchema.parse(valid).scenes.length, 2);
assert.equal(VideoDocumentSchema.safeParse({ ...valid, scenes: [{ ...valid.scenes[0], background: "red" }] }).success, false);
assert.equal(VideoDocumentSchema.safeParse({ ...valid, scenes: [{ ...valid.scenes[0], durationSeconds: 31 }] }).success, false);
assert.equal(VideoDocumentSchema.safeParse({ ...valid, scenes: Array.from({ length: 7 }, (_, i) => ({ ...valid.scenes[0], id: String(i), durationSeconds: 30 })) }).success, false);
assert.equal(VideoDocumentSchema.safeParse({ ...valid, scenes: [{ ...valid.scenes[0], audioFile: "../../secrets.mp3" }] }).success, false);
console.log("video-schema: 5 checks passed");
