import { loadServerEnv } from "@proximity/config";
import { startServer } from "./server.ts";
import { mediaProviderFromEnv } from "./livekit.ts";

const env = loadServerEnv();
const media = mediaProviderFromEnv(env);
const { server } = startServer(env, media);

console.log(
  `[proximity] world-server on ws://${server.hostname}:${server.port}/ws` +
    (media ? ` (media: LiveKit @ ${media.url})` : " (no media configured)"),
);
