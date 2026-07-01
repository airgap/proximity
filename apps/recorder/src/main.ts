import {
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import type { FullStroke, ServerMessage, StrokePoint } from "@proximity/protocol";

/**
 * Proximity recording template, loaded by LiveKit Egress (headless Chrome).
 *
 * Egress appends ?url=&token=&layout= to this page. We connect to the room for the presenter's
 * screenshare, and connect to the world server as a read-only OBSERVER for the annotation strokes,
 * compositing them on a canvas over the video — so recordings capture the drawings exactly as
 * viewers saw them. Readiness/teardown use the egress console protocol (START/END_RECORDING).
 */
const params = new URLSearchParams(location.search);
const lkUrl = params.get("url") ?? "";
const token = params.get("token") ?? "";

const screenEl = document.getElementById("screen") as HTMLVideoElement;
const canvas = document.getElementById("annot") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

const strokes = new Map<string, FullStroke>();

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  redraw();
}
window.addEventListener("resize", resize);

function redraw(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const dpr = window.devicePixelRatio || 1;
  const px = (p: StrokePoint) => [p.x * canvas.width, p.y * canvas.height] as const;
  for (const s of strokes.values()) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width * dpr;
    if (s.points.length === 1) {
      const [x, y] = px(s.points[0]!);
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    const [x0, y0] = px(s.points[0]!);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < s.points.length; i++) {
      const [x, y] = px(s.points[i]!);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Connect to the world server as a read-only observer for presentation annotations. */
function connectAnnotations(spaceId: string): void {
  const worldWs =
    (import.meta.env.VITE_WORLD_WS as string | undefined) ?? "ws://host.docker.internal:8080/ws";
  const ws = new WebSocket(worldWs);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ t: "join", spaceId, name: "recorder", avatarId: 0, observer: true }));
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let m: ServerMessage;
    try {
      m = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    if (m.t === "strokeSnapshot") {
      strokes.clear();
      for (const s of m.strokes) strokes.set(s.strokeId, { ...s, points: [...s.points] });
      redraw();
    } else if (m.t === "stroke") {
      let s = strokes.get(m.strokeId);
      if (!s) {
        s = { strokeId: m.strokeId, color: m.color, width: m.width, points: [] };
        strokes.set(m.strokeId, s);
      }
      s.points.push(...m.points);
      redraw();
    } else if (m.t === "strokeClear") {
      strokes.clear();
      redraw();
    }
  });
}

function onTrack(track: RemoteTrack, pub: RemoteTrackPublication): void {
  if (track instanceof RemoteVideoTrack && pub.source === Track.Source.ScreenShare) {
    track.attach(screenEl);
  }
}

async function main(): Promise<void> {
  resize();
  const room = new Room({ adaptiveStream: false, dynacast: false });
  room
    .on(RoomEvent.TrackSubscribed, (t, pub) => onTrack(t, pub))
    .on(RoomEvent.Disconnected, () => {
      // Tell egress to finalize the file.
      console.log("END_RECORDING");
    });

  await room.connect(lkUrl, token, { autoSubscribe: true });
  const spaceId = room.name.replace(/^space:/, "");
  connectAnnotations(spaceId);

  // Signal egress that the page is ready to be captured.
  console.log("START_RECORDING");
}

void main();
