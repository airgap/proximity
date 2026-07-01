/**
 * Synthetic-client load generator. Spawns N WebSocket clients that join one space and random-walk,
 * measuring connection success and inbound snapshot throughput. Doubles as the "100+/space stays
 * green" smoke gate.
 *
 * Usage:
 *   parabun apps/loadgen/src/index.ts --n 100 --seconds 10 --url ws://localhost:8080/ws
 */
import { BinaryTag, binaryTagOf, decodeSnapshot } from "@proximity/protocol";

interface Args {
  n: number;
  seconds: number;
  url: string;
  space: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
  };
  return {
    n: parseInt(get("--n", process.env.N ?? "100"), 10),
    seconds: parseInt(get("--seconds", process.env.SECONDS ?? "10"), 10),
    url: get("--url", process.env.WS_URL ?? "ws://localhost:8080/ws"),
    space: get("--space", process.env.SPACE ?? "loadtest"),
  };
}

interface Bot {
  ws: WebSocket;
  connected: boolean;
  joined: boolean;
  snapshots: number;
  entitiesSeen: number;
  x: number;
  y: number;
  seq: number;
  vx: number;
  vy: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[loadgen] spawning ${args.n} clients -> ${args.url} (space=${args.space}) for ${args.seconds}s`,
  );

  const bots: Bot[] = [];
  const start = performance.now();

  for (let i = 0; i < args.n; i++) {
    const ws = new WebSocket(args.url);
    ws.binaryType = "arraybuffer";
    const bot: Bot = {
      ws,
      connected: false,
      joined: false,
      snapshots: 0,
      entitiesSeen: 0,
      x: 4 + (i % 20),
      y: 4 + Math.floor(i / 20),
      seq: 0,
      vx: Math.cos(i) * 0.3,
      vy: Math.sin(i) * 0.3,
    };
    ws.addEventListener("open", () => {
      bot.connected = true;
      ws.send(JSON.stringify({ t: "join", spaceId: args.space, name: `bot${i}`, avatarId: 0 }));
    });
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data as string);
        if (m.t === "welcome") bot.joined = true;
      } else {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        if (binaryTagOf(buf) === BinaryTag.Snapshot) {
          bot.snapshots++;
          bot.entitiesSeen += decodeSnapshot(buf).entities.length;
        }
      }
    });
    bots.push(bot);
    // Small stagger so we don't SYN-flood the accept queue.
    if (i % 25 === 24) await Bun.sleep(15);
  }

  // Random-walk: bounce around a bounded region, sending moves at ~10 Hz.
  const moveTimer = setInterval(() => {
    for (const bot of bots) {
      if (!bot.joined) continue;
      bot.x += bot.vx;
      bot.y += bot.vy;
      if (bot.x < 2 || bot.x > 40) bot.vx *= -1;
      if (bot.y < 2 || bot.y > 26) bot.vy *= -1;
      const facing = Math.abs(bot.vx) > Math.abs(bot.vy) ? (bot.vx < 0 ? 2 : 3) : bot.vy < 0 ? 1 : 0;
      if (bot.ws.readyState === WebSocket.OPEN) {
        bot.ws.send(
          JSON.stringify({ t: "move", x: bot.x, y: bot.y, facing, moving: true, seq: ++bot.seq }),
        );
      }
    }
  }, 100);

  await Bun.sleep(args.seconds * 1000);
  clearInterval(moveTimer);

  const elapsed = (performance.now() - start) / 1000;
  const connected = bots.filter((b) => b.connected).length;
  const joined = bots.filter((b) => b.joined).length;
  const totalSnapshots = bots.reduce((s, b) => s + b.snapshots, 0);
  const totalEntities = bots.reduce((s, b) => s + b.entitiesSeen, 0);

  for (const b of bots) b.ws.close();
  await Bun.sleep(200);

  console.log("─".repeat(48));
  console.log(`clients connected : ${connected}/${args.n}`);
  console.log(`clients joined    : ${joined}/${args.n}`);
  console.log(`snapshots recv    : ${totalSnapshots} (${(totalSnapshots / elapsed).toFixed(0)}/s)`);
  console.log(`avg snapshots/bot : ${(totalSnapshots / Math.max(1, joined)).toFixed(1)}`);
  console.log(`avg neighbors seen: ${(totalEntities / Math.max(1, totalSnapshots)).toFixed(1)}`);
  console.log("─".repeat(48));

  const ok = connected === args.n && joined === args.n && totalSnapshots > 0;
  console.log(`RESULT: ${ok ? "GREEN" : "RED"}`);
  process.exit(ok ? 0 : 1);
}

void main();
