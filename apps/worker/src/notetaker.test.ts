import { expect, test } from "bun:test";
import { extractNote, generateNote, noteToMarkdown } from "./notetaker.ts";

const TRANSCRIPT = `Welcome everyone to the Q3 planning sync. We reviewed the migration status.
We decided to move the database to the new cluster next month. Nicole will draft the rollout plan by Friday.
Bob agreed to own the load testing. Let's follow up on the CDN costs next week. The weather was nice today.`;

test("extractNote pulls decisions and action items deterministically", () => {
  const note = extractNote(TRANSCRIPT);
  expect(note.engine).toBe("extractive");
  expect(note.summary.length).toBeGreaterThan(0);

  const decisions = note.decisions.join(" ").toLowerCase();
  expect(decisions).toContain("decided to move the database");

  const actions = note.actionItems.join(" ").toLowerCase();
  expect(actions).toContain("nicole will draft"); // "will" + owner
  expect(actions).toContain("follow up on the cdn"); // "let's follow up"
  // The filler sentence is not an action item.
  expect(actions).not.toContain("weather was nice");
});

test("generateNote falls back to extractive with no model", async () => {
  const note = await generateNote(TRANSCRIPT, {});
  expect(note.engine).toBe("extractive");
  expect(note.actionItems.length).toBeGreaterThan(0);
});

test("noteToMarkdown renders a shareable doc with checkboxes", () => {
  const md = noteToMarkdown(extractNote(TRANSCRIPT), { spaceId: "group:eng", transcriptRef: "rec.vtt" });
  expect(md).toContain("# Meeting Notes");
  expect(md).toContain("## Summary");
  expect(md).toContain("## Action Items");
  expect(md).toContain("- [ ] "); // action items as checkboxes
  expect(md).toContain("[Full transcript](rec.vtt)");
});

test("empty transcript yields an empty-but-valid note", () => {
  const note = extractNote("");
  expect(note.decisions).toEqual([]);
  expect(note.actionItems).toEqual([]);
});
