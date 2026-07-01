import { AccessToken, type VideoGrant } from "livekit-server-sdk";
import type { ServerEnv } from "@proximity/config";

/**
 * Media provider: mints LiveKit access tokens and maps spaces -> rooms.
 *
 * THE INVARIANT: token `identity` MUST equal the world-server userId, so a proximity event
 * ("user u_7 is near you") maps 1:1 to a LiveKit RemoteParticipant on the client.
 */
export interface MediaProvider {
  readonly url: string;
  roomName(spaceId: string): string;
  mintToken(identity: string, name: string, room: string): Promise<string>;
}

export class LiveKitMediaProvider implements MediaProvider {
  readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(url: string, apiKey: string, apiSecret: string) {
    this.url = url;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  roomName(spaceId: string): string {
    return `space:${spaceId}`;
  }

  async mintToken(identity: string, name: string, room: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity, // == world userId
      name,
      ttl: "15m",
    });
    const grant: VideoGrant = {
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
    };
    at.addGrant(grant);
    return at.toJwt();
  }
}

/** Build a MediaProvider from env, or null if LiveKit isn't fully configured. */
export function mediaProviderFromEnv(env: ServerEnv): MediaProvider | null {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  return new LiveKitMediaProvider(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}
