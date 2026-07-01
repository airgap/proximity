import { expect, test } from "bun:test";
import { loadServerEnv } from "@proximity/config";
import type { ProximityGrant } from "@proximity/protocol";
import {
  grantAllowsSpace,
  OpenVerifier,
  signGrant,
  tenantScopedKey,
  verifierFromEnv,
} from "./auth.ts";

const SECRET = "test_secret_at_least_32_chars_long_xyz";

function env(over: Record<string, string> = {}) {
  return loadServerEnv({ PROXIMITY_AUTH_MODE: "shared_secret", PROXIMITY_GRANT_SECRET: SECRET, ...over });
}

const grant: ProximityGrant = {
  sub: "u_42",
  name: "Nicole",
  tenant: "org_7",
  spaces: ["group:eng", "world:nicoles-private"],
  caps: ["join", "present", "record", "annotate"],
};

test("shared_secret: sign -> verify round-trips the grant", async () => {
  const v = verifierFromEnv(env());
  const token = await signGrant(grant, SECRET);
  const out = await v.fromToken(token);
  expect(out).not.toBeNull();
  expect(out!.sub).toBe("u_42");
  expect(out!.name).toBe("Nicole");
  expect(out!.tenant).toBe("org_7");
  expect(out!.spaces).toEqual(["group:eng", "world:nicoles-private"]);
  expect(out!.caps).toContain("record");
});

test("shared_secret: wrong secret is rejected", async () => {
  const v = verifierFromEnv(env());
  const token = await signGrant(grant, "a_different_secret_but_also_32_chars_x");
  expect(await v.fromToken(token)).toBeNull();
});

test("shared_secret: expired token is rejected", async () => {
  const v = verifierFromEnv(env());
  const token = await signGrant(grant, SECRET, -10); // already expired
  expect(await v.fromToken(token)).toBeNull();
});

test("shared_secret: garbage token is rejected", async () => {
  const v = verifierFromEnv(env());
  expect(await v.fromToken("not.a.jwt")).toBeNull();
});

test("grantAllowsSpace enforces the space list (and wildcard)", () => {
  expect(grantAllowsSpace(grant, "group:eng")).toBe(true);
  expect(grantAllowsSpace(grant, "world:nicoles-private")).toBe(true);
  expect(grantAllowsSpace(grant, "group:sales")).toBe(false);
  expect(grantAllowsSpace({ ...grant, spaces: ["*"] }, "anything")).toBe(true);
});

test("tenantScopedKey isolates spaces per tenant", () => {
  expect(tenantScopedKey(grant, "group:eng")).toBe("org_7:group:eng");
  expect(tenantScopedKey({ ...grant, tenant: undefined }, "group:eng")).toBe("group:eng");
});

test("open mode grants an anonymous wildcard identity", () => {
  const v = new OpenVerifier();
  const g = v.anonymous("Guest McGee");
  expect(g).not.toBeNull();
  expect(g!.sub.startsWith("anon_")).toBe(true);
  expect(g!.name).toBe("Guest McGee");
  expect(grantAllowsSpace(g!, "any-space")).toBe(true);
});

test("verifierFromEnv fails fast when shared_secret has no secret", () => {
  expect(() => verifierFromEnv(loadServerEnv({ PROXIMITY_AUTH_MODE: "shared_secret" }))).toThrow();
});
