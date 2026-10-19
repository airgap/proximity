import { expect, test } from "bun:test";
import { drainNotes, hmacHex, postNote, retryDelay, MAX_ATTEMPTS, type Delivery } from "./delivery.ts";

const row: Delivery = { egress_id: "synthetic-egress", payload: JSON.stringify({ deliveryId: "proximity-note:synthetic-egress", note: "fixture" }), attempts: 1, lease_token: "lease" };

test("signed successful delivery keeps stable identity and exact persisted bytes", async () => {
  let captured: RequestInit | undefined;
  const fetcher = (async (_url, init) => { captured = init; return new Response("ok"); }) as typeof fetch;
  await postNote(row, "https://receiver.invalid/notes", "fixture-secret", fetcher);
  expect(captured?.body).toBe(row.payload);
  const headers = captured?.headers as Record<string, string>;
  expect(headers["idempotency-key"]).toBe("proximity-note:synthetic-egress");
  expect(headers["x-proximity-signature"]).toBe(await hmacHex(row.payload, "fixture-secret"));
});

for (const status of [400, 401, 429, 500, 503]) test(`HTTP ${status} fails delivery`, async () => {
  await expect(postNote(row, "https://receiver.invalid", undefined,
    (async () => new Response("untrusted body", { status })) as typeof fetch)).rejects.toThrow(`HTTP ${status}`);
});

test("network failure and timeout reject instead of acknowledging", async () => {
  await expect(postNote(row, "https://receiver.invalid", undefined,
    (async () => { throw new TypeError("offline"); }) as typeof fetch)).rejects.toThrow("offline");
  const hanging = ((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  await expect(postNote(row, "https://receiver.invalid", undefined, hanging, 5)).rejects.toThrow();
});

test("disabled receiver leaves persistent work untouched", async () => {
  await drainNotes({ claim: async () => { throw new Error("must not claim"); }, delivered: async () => {}, failed: async () => {} }, undefined);
});

test("drain acknowledges only success and persists failure before returning", async () => {
  const events: string[] = [];
  let pending = true;
  const store = {
    claim: async () => pending ? (pending = false, row) : undefined,
    delivered: async () => { events.push("delivered"); },
    failed: async () => { events.push("failed"); },
  };
  await drainNotes(store, "fixture", undefined, async () => { throw new Error("offline"); });
  expect(events).toEqual(["failed"]);
  pending = true;
  await drainNotes(store, "fixture", undefined, async () => {});
  expect(events).toEqual(["failed", "delivered"]);
});

test("one drain is bounded to three deliveries and exponential backoff is capped", async () => {
  let attempts = 0;
  await drainNotes({ claim: async () => row, delivered: async () => {}, failed: async () => {} },
    "fixture", undefined, async () => { attempts++; });
  expect(attempts).toBe(3);
  expect(retryDelay(1)).toBe(30_000);
  expect(retryDelay(2)).toBe(60_000);
  expect(retryDelay(MAX_ATTEMPTS)).toBe(3_600_000);
  expect(retryDelay(100)).toBe(3_600_000);
});
