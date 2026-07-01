import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { decodeAudio, toMono16k, toVtt, transcribe } from "./transcribe.ts";

// Gated: set PROXIMITY_TEST_MODELS to a dir containing jfk.wav + ggml-tiny.en.bin to run.
// (Kept out of default CI so the suite doesn't require large model downloads.)
const dir = process.env.PROXIMITY_TEST_MODELS;
const wav = dir ? `${dir}/jfk.wav` : "";
const model = dir ? `${dir}/ggml-tiny.en.bin` : "";
const canRun = Boolean(dir) && existsSync(wav) && existsSync(model);

test.skipIf(!canRun)("transcribes jfk.wav through the Parabun whisper pipeline", async () => {
  const bytes = await Bun.file(wav).bytes();
  const clip = await decodeAudio(bytes);
  expect(clip.sampleRate).toBeGreaterThan(0);

  const mono = await toMono16k(clip);
  const text = await transcribe(mono, model);
  expect(text.toLowerCase()).toContain("country");

  const vtt = toVtt(text, 11_000);
  expect(vtt.startsWith("WEBVTT")).toBe(true);
  expect(vtt).toContain(text);
});
