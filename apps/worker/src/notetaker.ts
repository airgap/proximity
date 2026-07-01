/**
 * Notetaker: turn a meeting transcript into a structured note (summary + decisions + action items).
 *
 * Uses a local LLM via Parabun when a model is configured; otherwise falls back to a deterministic
 * extractive pass so a useful note is produced with zero model download. The LLM import is lazy so
 * this module (and its tests) load under standard Bun too.
 */

export interface MeetingNote {
  summary: string;
  decisions: string[];
  actionItems: string[];
  /** How the note was produced. */
  engine: "llm" | "extractive";
}

const ACTION_RE =
  /\b(action item|to-?do|i'?ll |we'?ll |let'?s |follow[- ]?up|assign(ed|s)?|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|eod|next week|end of)|needs? to|make sure|take care of|owns?\b)/i;
const DECISION_RE =
  /\b(decided|we agreed|agreed to|the decision|going with|we'?ll go with|conclusion|resolved to|settled on)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function dedupeCap(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= cap) break;
  }
  return out;
}

/** Deterministic, model-free note extraction. */
export function extractNote(transcript: string): MeetingNote {
  const sents = sentences(transcript);
  const decisions = dedupeCap(
    sents.filter((s) => DECISION_RE.test(s)),
    10,
  );
  const actionItems = dedupeCap(
    sents.filter((s) => ACTION_RE.test(s)),
    15,
  );
  // Lead summary: first couple of sentences, trimmed to a sane length.
  const summary = sents.slice(0, 3).join(" ").slice(0, 600) || transcript.slice(0, 300);
  return { summary, decisions, actionItems, engine: "extractive" };
}

/** Best-effort JSON extraction from an LLM completion. */
function parseNoteJson(out: string): Partial<MeetingNote> | null {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1)) as Partial<MeetingNote>;
  } catch {
    return null;
  }
}

const NOTE_PROMPT = `You are a meeting notetaker. From the transcript, produce STRICT JSON:
{"summary": string, "decisions": string[], "actionItems": string[]}
- summary: 2-4 sentences.
- decisions: concrete decisions made (empty array if none).
- actionItems: concrete follow-ups, each ideally naming an owner (empty array if none).
Return ONLY the JSON. Transcript:
`;

/** Generate a note, using the local LLM if a model path is given, else the extractive fallback. */
export async function generateNote(
  transcript: string,
  opts: { llmModel?: string } = {},
): Promise<MeetingNote> {
  const fallback = extractNote(transcript);
  if (!opts.llmModel || !transcript.trim()) return fallback;

  try {
    const mod = await import("parabun:llm");
    const llm = (mod as any).default ?? mod;
    const model = await llm.LLM.load(opts.llmModel);
    let out = "";
    for await (const piece of model.chat([
      { role: "user", content: NOTE_PROMPT + transcript.slice(0, 8000) },
    ])) {
      out += piece;
    }
    (model.close ?? model[Symbol.dispose])?.call(model);

    const parsed = parseNoteJson(out);
    if (!parsed || typeof parsed.summary !== "string") return fallback;
    return {
      summary: parsed.summary,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      engine: "llm",
    };
  } catch {
    return fallback; // model missing / load failed -> still produce a note
  }
}

/** Render a note as a shareable Markdown document. */
export function noteToMarkdown(
  note: MeetingNote,
  meta: { spaceId?: string; when?: string; transcriptRef?: string } = {},
): string {
  const lines: string[] = ["# Meeting Notes"];
  const bits = [meta.spaceId && `space: ${meta.spaceId}`, meta.when && meta.when, `via ${note.engine}`]
    .filter(Boolean)
    .join(" · ");
  if (bits) lines.push(`_${bits}_`);
  lines.push("", "## Summary", note.summary || "_(none)_");
  lines.push("", "## Decisions");
  lines.push(note.decisions.length ? note.decisions.map((d) => `- ${d}`).join("\n") : "_(none)_");
  lines.push("", "## Action Items");
  lines.push(
    note.actionItems.length ? note.actionItems.map((a) => `- [ ] ${a}`).join("\n") : "_(none)_",
  );
  if (meta.transcriptRef) lines.push("", `[Full transcript](${meta.transcriptRef})`);
  return lines.join("\n") + "\n";
}
