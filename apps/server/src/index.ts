import { loadServerEnv } from "@proximity/config";
import { startServer } from "./server.ts";

const env = loadServerEnv();
const { server } = startServer(env);

console.log(`[proximity] world-server listening on ws://${server.hostname}:${server.port}/ws`);
