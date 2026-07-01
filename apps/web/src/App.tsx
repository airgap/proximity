import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { GameClient } from "./game/GameClient.ts";

function wsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

interface ChatLine {
  name: string;
  body: string;
  id: number;
}

export function App() {
  const [joined, setJoined] = useState(false);
  const [name, setName] = useState("");

  if (!joined) {
    return <JoinScreen name={name} setName={setName} onJoin={() => setJoined(true)} />;
  }
  return <Stage name={name.trim() || "Guest"} />;
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
  const chatId = useRef(0);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const game = new GameClient(wsUrl(), props.name, 0);
    gameRef.current = game;
    game.onStatus = (s) => setStatus(s);
    game.onChat = (n, b) =>
      setChat((prev) => [...prev.slice(-49), { name: n, body: b, id: chatId.current++ }]);
    void game.mount(el);
    return () => {
      game.destroy();
      gameRef.current = null;
    };
  }, [props.name]);

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
