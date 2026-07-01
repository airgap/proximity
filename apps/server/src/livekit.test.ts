import { expect, test } from "bun:test";
import { LiveKitMediaProvider, mediaProviderFromEnv } from "./livekit.ts";
import { loadServerEnv } from "@proximity/config";

test("mints a token with identity == userId and the correct room grant", async () => {
  const mp = new LiveKitMediaProvider("ws://lk:7880", "devkey", "a_secret_that_is_long_enough_123456");
  expect(mp.roomName("myspace")).toBe("space:myspace");

  const token = await mp.mintToken("u_42", "Alice", mp.roomName("myspace"));
  const claims = JSON.parse(atob(token.split(".")[1]!));

  // The load-bearing invariant: token identity == world userId.
  expect(claims.sub).toBe("u_42");
  expect(claims.name).toBe("Alice");
  expect(claims.video.room).toBe("space:myspace");
  expect(claims.video.roomJoin).toBe(true);
  expect(claims.video.canPublish).toBe(true);
  expect(claims.video.canSubscribe).toBe(true);
});

test("mediaProviderFromEnv is null unless LiveKit is fully configured", () => {
  expect(mediaProviderFromEnv(loadServerEnv({}))).toBeNull();
  const provider = mediaProviderFromEnv(
    loadServerEnv({
      LIVEKIT_URL: "ws://lk:7880",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "a_secret_that_is_long_enough_123456",
    }),
  );
  expect(provider).not.toBeNull();
  expect(provider!.url).toBe("ws://lk:7880");
});
