import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { GameClient, type MediaState, type PresentationUiState } from "./game/GameClient.ts";

const ANNOTATION_COLORS = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#ffffff"];

function wsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** When embedded by a host (e.g. lyku), the grant token + space arrive via query params. */
function hostContext(): { token?: string; space: string } {
  const q = new URLSearchParams(location.search);
  return {
    token: q.get("token") ?? (import.meta.env.VITE_PROXIMITY_TOKEN as string | undefined),
    space: q.get("space") ?? "default",
  };
}

/**
 * The authoritative display name from the grant's `name` claim (== the user's
 * lyku.co display name). The server already stamps this on the avatar for other
 * viewers; reading it here keeps the LOCAL label consistent and lets an embedded
 * session skip the "your name" prompt entirely. No verification needed on the
 * client — the world server verifies the token; this is display only.
 */
function grantName(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { name?: unknown };
    return typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;
  } catch {
    return null;
  }
}

interface ChatLine {
  name: string;
  body: string;
  id: number;
}

export function App() {
  // Embedded by a host (lyku): the grant carries the identity, so skip the name
  // prompt and always use the lyku.co name. Standalone: prompt for a name.
  const embeddedName = grantName(hostContext().token);
  const [joined, setJoined] = useState(embeddedName !== null);
  const [name, setName] = useState("");

  if (!joined) {
    return <JoinScreen name={name} setName={setName} onJoin={() => setJoined(true)} />;
  }
  return <Stage name={embeddedName ?? (name.trim() || "Guest")} />;
}

function JoinScreen(props: { name: string; setName: (s: string) => void; onJoin: () => void }) {
  return (
    <div style={styles.center}>
      <div style={styles.card}>
        <h1 style={{ margin: "0 0 4px", fontSize: 28 }}>Proximity</h1>
        <p style={{ margin: "0 0 20px", color: "#9aa0b4", fontSize: 14 }}>
          Walk around. Get close to people to talk (media lands in phase 2).
        </p>
        <input
          style={styles.input}
          placeholder="Your name"
          value={props.name}
          autoFocus
          onChange={(e) => props.setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onJoin()}
        />
        <button style={styles.button} onClick={props.onJoin}>
          Enter the Atrium
        </button>
      </div>
    </div>
  );
}

function Stage(props: { name: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameClient | null>(null);
  const [status, setStatus] = useState("connecting");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [media, setMedia] = useState<MediaState | null>(null);
  const [pres, setPres] = useState<PresentationUiState | null>(null);
  const [record, setRecord] = useState(false);
  const chatId = useRef(0);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const { token, space } = hostContext();
    const game = new GameClient(wsUrl(), props.name, 0, space, token);
    gameRef.current = game;
    game.onStatus = (s) => setStatus(s);
    game.onMedia = (s) => setMedia(s);
    game.onPresentation = (s) => setPres(s);
    game.onChat = (n, b) =>
      setChat((prev) => [...prev.slice(-49), { name: n, body: b, id: chatId.current++ }]);
    game.onChatHistory = (msgs) =>
      setChat((prev) => [
        ...msgs.map((m) => ({ name: m.name, body: m.body, id: chatId.current++ })),
        ...prev,
      ]);
    void game.mount(el);
    return () => {
      game.destroy();
      gameRef.current = null;
    };
  }, [props.name]);

  const toggleMic = useCallback(async () => {
    const s = await gameRef.current?.toggleMic();
    if (s) setMedia(s);
  }, []);
  const toggleCam = useCallback(async () => {
    const s = await gameRef.current?.toggleCam();
    if (s) setMedia(s);
  }, []);
  const toggleScreen = useCallback(async () => {
    const s = await gameRef.current?.toggleScreen();
    if (s) setMedia(s);
  }, []);
  const togglePresent = useCallback(() => {
    const g = gameRef.current;
    if (!g) return;
    if (pres?.active && pres.isPresenter) g.stopPresentation();
    else if (!pres?.active) g.startPresentation(record);
  }, [pres, record]);

  const sendChat = useCallback(() => {
    const body = draft.trim();
    if (!body) return;
    gameRef.current?.sendChat(body);
    setDraft("");
  }, [draft]);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />

      <div style={styles.hud}>
        <span style={{ ...styles.dot, background: statusColor(status) }} /> {status}
        <span style={{ color: "#6b7089", marginLeft: 10 }}>WASD / arrows to move</span>
      </div>

      {media?.connected && (
        <div style={styles.controls}>
          <button
            style={{ ...styles.ctrlBtn, background: media.mic ? "#4f46e5" : "#33334d" }}
            onClick={toggleMic}
            title="Toggle microphone"
          >
            {media.mic ? "🎤 Mic on" : "🔇 Mic off"}
          </button>
          <button
            style={{ ...styles.ctrlBtn, background: media.cam ? "#4f46e5" : "#33334d" }}
            onClick={toggleCam}
            title="Toggle camera"
          >
            {media.cam ? "📷 Cam on" : "🚫 Cam off"}
          </button>
          <button
            style={{ ...styles.ctrlBtn, background: media.screen ? "#eab308" : "#33334d" }}
            onClick={toggleScreen}
            title="Share your screen"
          >
            {media.screen ? "🖥️ Sharing" : "🖥️ Share"}
          </button>

          {(!pres?.active || pres.isPresenter) && (
            <button
              style={{ ...styles.ctrlBtn, background: pres?.isPresenter ? "#dc2626" : "#33334d" }}
              onClick={togglePresent}
              title="Present to everyone in this space"
            >
              {pres?.isPresenter ? "⏹ Stop presenting" : "📊 Present"}
            </button>
          )}
          {!pres?.active && (
            <label style={styles.recordLabel}>
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
              rec
            </label>
          )}

          {pres?.isPresenter && (
            <>
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  style={{ ...styles.swatch, background: c }}
                  onClick={() => gameRef.current?.setAnnotationColor(c)}
                  title={`Draw in ${c}`}
                />
              ))}
              <button
                style={{ ...styles.ctrlBtn, background: "#33334d" }}
                onClick={() => gameRef.current?.clearAnnotations()}
              >
                🧹 Clear
              </button>
            </>
          )}
        </div>
      )}

      {pres?.active && !pres.isPresenter && (
        <div style={styles.presBanner}>
          📊 {pres.presenterName ?? "Someone"} is presenting
          {pres.recording && <span style={styles.recDot}>● REC</span>}
        </div>
      )}
      {pres?.isPresenter && pres.recording && (
        <div style={styles.presBanner}>
          <span style={styles.recDot}>● REC</span> You are presenting
        </div>
      )}

      <div style={styles.chatPanel}>
        <div style={styles.chatLog}>
          {chat.map((c) => (
            <div key={c.id} style={{ marginBottom: 2 }}>
              <b style={{ color: "#8ab4ff" }}>{c.name}</b>: {c.body}
            </div>
          ))}
        </div>
        <input
          style={styles.chatInput}
          placeholder="Say something…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendChat()}
        />
      </div>
    </div>
  );
}

function statusColor(s: string): string {
  return s === "open" ? "#4ade80" : s === "connecting" ? "#facc15" : "#f87171";
}

const styles: Record<string, CSSProperties> = {
  center: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#e5e7eb",
  },
  card: {
    background: "#1b1b2b",
    padding: 32,
    borderRadius: 16,
    width: 360,
    boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
    border: "1px solid #2a2a40",
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #33334d",
    background: "#12121e",
    color: "#e5e7eb",
    fontSize: 15,
    marginBottom: 12,
  },
  button: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "none",
    background: "#4f46e5",
    color: "white",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  hud: {
    position: "absolute",
    top: 12,
    left: 12,
    background: "rgba(18,18,30,0.8)",
    color: "#e5e7eb",
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 6,
    backdropFilter: "blur(6px)",
  },
  dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  controls: {
    position: "absolute",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    gap: 8,
    zIndex: 5,
  },
  ctrlBtn: {
    padding: "8px 14px",
    borderRadius: 999,
    border: "none",
    color: "white",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    backdropFilter: "blur(6px)",
  },
  recordLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: "#9aa0b4",
    fontSize: 12,
    background: "rgba(18,18,30,0.7)",
    padding: "6px 10px",
    borderRadius: 999,
  },
  swatch: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.5)",
    cursor: "pointer",
    padding: 0,
  },
  presBanner: {
    position: "absolute",
    top: 12,
    left: "50%",
    transform: "translateX(-50%)",
    background: "rgba(18,18,30,0.85)",
    color: "#e5e7eb",
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: 8,
    zIndex: 6,
    backdropFilter: "blur(6px)",
  },
  recDot: { color: "#f87171", fontSize: 12, fontWeight: 700 },
  chatPanel: {
    position: "absolute",
    bottom: 12,
    left: 12,
    width: 320,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  chatLog: {
    maxHeight: 180,
    overflowY: "auto",
    color: "#d1d5db",
    fontSize: 13,
    background: "rgba(18,18,30,0.7)",
    borderRadius: 8,
    padding: "8px 10px",
    backdropFilter: "blur(6px)",
  },
  chatInput: {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid #33334d",
    background: "rgba(18,18,30,0.9)",
    color: "#e5e7eb",
    fontSize: 13,
  },
};
