// @ts-expect-error - parabun builtin module (no TS types)
import audio from "parabun:audio";
// @ts-expect-error - parabun builtin module (no TS types)
import speech from "parabun:speech";

/**
 * Recording post-processing DSP, built on Parabun's native audio/speech modules.
 * Verified against whisper.cpp's jfk.wav sample (see transcribe.test.ts).
 */

export interface AudioClip {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

const TARGET_RATE = 16000; // whisper wants 16 kHz mono

/** Decode WAV (fast path) or any media file's audio track to PCM samples. */
export function decodeAudio(bytes: Uint8Array): AudioClip {
  try {
    const w = audio.readWav(bytes);
    return { samples: w.samples, sampleRate: w.sampleRate, channels: w.channels };
  } catch {
    const d = audio.decodeFile(bytes); // e.g. audio track of an MP4/MP3
    return { samples: d.samples, sampleRate: d.sampleRate, channels: d.channels ?? 1 };
  }
}

/** Downmix to mono and resample to 16 kHz. */
export function toMono16k(clip: AudioClip): Float32Array {
  let mono = clip.samples;
  if (clip.channels > 1) {
    const chans = audio.deinterleave(clip.samples, clip.channels) as Float32Array[];
    const n = chans[0].length;
    mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < clip.channels; c++) s += chans[c][i];
      mono[i] = s / clip.channels;
    }
  }
  if (clip.sampleRate !== TARGET_RATE) {
    mono = audio.resample(mono, { from: clip.sampleRate, to: TARGET_RATE });
  }
  // Normalize levels for cleaner recognition.
  try {
    mono = audio.normalize(mono, { targetPeak: 0.95 }) ?? mono;
  } catch {
    /* normalize is best-effort */
  }
  return mono;
}

/** Transcribe 16 kHz mono PCM to text using a whisper ggml model. */
export async function transcribe(samples16k: Float32Array, modelPath: string): Promise<string> {
  const out = await speech.transcribe(
    { samples: samples16k, sampleRate: TARGET_RATE },
    { engine: "whisper", model: modelPath },
  );
  return (typeof out === "string" ? out : (out?.text ?? String(out))).trim();
}

/** Full pipeline: audio bytes -> transcript text. */
export async function transcribeRecording(bytes: Uint8Array, modelPath: string): Promise<string> {
  return transcribe(toMono16k(decodeAudio(bytes)), modelPath);
}

function fmtTs(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = Math.floor(ms % 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(milli, 3)}`;
}

/** Wrap a transcript as a single-cue WebVTT covering the whole clip. */
export function toVtt(text: string, durationMs: number): string {
  return `WEBVTT\n\n00:00:00.000 --> ${fmtTs(Math.max(1000, durationMs))}\n${text}\n`;
}
