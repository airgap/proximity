import type { ServerEnv } from "@proximity/config";

/**
 * Outbound integration with the host (lyku): signed webhooks for in-world chat, and HMAC
 * verification of inbound host requests (chat inject). Signed with the same shared secret the
 * host uses to mint grants (PROXIMITY_GRANT_SECRET), so the host can trust/verify us and vice
 * versa. Signatures are HMAC-SHA256 hex over the raw JSON body (matches host Web Crypto).
 */
export async function hmacHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface ChatEgress {
  spaceId: string;
  from: { id: string; name: string };
  body: string;
  origin: "world";
}

export class HostHooks {
  constructor(
    private readonly secret: string,
    private readonly chatUrl: string | undefined,
  ) {}

  /** Forward an in-world (user-typed) chat message to the host, signed. Fire-and-forget. */
  emitChat(msg: ChatEgress): void {
    if (!this.chatUrl) return;
    void this.post(this.chatUrl, msg);
  }

  /** Verify an inbound host request body against its signature header. */
  async verify(body: string, signature: string | null): Promise<boolean> {
    if (!signature) return false;
    return timingSafeEqual(await hmacHex(body, this.secret), signature);
  }

  private async post(url: string, payload: unknown): Promise<void> {
    try {
      const body = JSON.stringify(payload);
      const sig = await hmacHex(body, this.secret);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-proximity-signature": sig },
        body,
      });
    } catch (err) {
      console.error("[proximity] host webhook failed:", err);
    }
  }
}

/** Build HostHooks from env, or null if no grant secret is configured. */
export function hostHooksFromEnv(env: ServerEnv): HostHooks | null {
  if (!env.PROXIMITY_GRANT_SECRET) return null;
  return new HostHooks(env.PROXIMITY_GRANT_SECRET, env.HOST_CHAT_WEBHOOK_URL);
}
