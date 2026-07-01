import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  WebhookReceiver,
  type VideoGrant,
} from "livekit-server-sdk";
import type { ServerEnv } from "@proximity/config";

/**
 * Media provider: mints LiveKit access tokens, maps spaces -> rooms, and (when object storage is
 * configured) drives LiveKit Egress for recording.
 *
 * THE INVARIANT: token `identity` MUST equal the world-server userId, so a proximity event
 * ("user u_7 is near you") maps 1:1 to a LiveKit RemoteParticipant on the client.
 */
export interface MediaProvider {
  readonly url: string;
  /** Whether recording (Egress) is configured (S3 present). */
  readonly canRecord: boolean;
  roomName(spaceId: string): string;
  mintToken(identity: string, name: string, room: string): Promise<string>;
  /** Start a room-composite recording; returns the egress id. Throws if !canRecord. */
  startEgress(room: string, spaceId: string, presenterId: string): Promise<string>;
  stopEgress(egressId: string): Promise<void>;
}

export interface EgressConfig {
  /** HTTP(S) base URL of the LiveKit server API (server-side; may differ from the browser ws url). */
  httpUrl: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKey: string;
    secret: string;
    forcePathStyle: boolean;
  };
  /** Optional custom egress template URL (bakes annotations); falls back to the built-in grid layout. */
  templateUrl?: string;
}

export class LiveKitMediaProvider implements MediaProvider {
  readonly url: string;
  readonly canRecord: boolean;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly egressConfig: EgressConfig | null;
  private readonly egressClient: EgressClient | null;

  constructor(url: string, apiKey: string, apiSecret: string, egress: EgressConfig | null = null) {
    this.url = url;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.egressConfig = egress;
    this.canRecord = egress !== null;
    this.egressClient = egress ? new EgressClient(egress.httpUrl, apiKey, apiSecret) : null;
  }

  roomName(spaceId: string): string {
    return `space:${spaceId}`;
  }

  async mintToken(identity: string, name: string, room: string): Promise<string> {
    const at = new AccessToken(this.apiKey, this.apiSecret, { identity, name, ttl: "15m" });
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

  async startEgress(room: string, spaceId: string, _presenterId: string): Promise<string> {
    if (!this.egressClient || !this.egressConfig) throw new Error("recording not configured");
    const s3 = this.egressConfig.s3;
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: `recordings/${spaceId}/{room_name}-{time}.mp4`,
      output: {
        case: "s3",
        value: new S3Upload({
          accessKey: s3.accessKey,
          secret: s3.secret,
          bucket: s3.bucket,
          region: s3.region,
          endpoint: s3.endpoint,
          forcePathStyle: s3.forcePathStyle,
        }),
      },
    });
    const info = await this.egressClient.startRoomCompositeEgress(
      room,
      { file: fileOutput },
      this.egressConfig.templateUrl
        ? { customBaseUrl: this.egressConfig.templateUrl }
        : { layout: "grid" },
    );
    return info.egressId;
  }

  async stopEgress(egressId: string): Promise<void> {
    if (!this.egressClient) return;
    await this.egressClient.stopEgress(egressId);
  }
}

/** Convert a ws(s):// LiveKit url to an http(s):// API url. */
function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http");
}

/** Build a MediaProvider from env, or null if LiveKit isn't fully configured. */
export function mediaProviderFromEnv(env: ServerEnv): MediaProvider | null {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;

  // Recording requires S3 (bucket + creds). If absent, media works without recording.
  let egress: EgressConfig | null = null;
  if (env.S3_BUCKET && env.S3_ACCESS_KEY && env.S3_SECRET_KEY) {
    egress = {
      httpUrl: env.LIVEKIT_HTTP_URL || toHttpUrl(env.LIVEKIT_URL),
      s3: {
        // The egress container performs the upload, so it needs an endpoint reachable from
        // inside that container (EGRESS_S3_ENDPOINT), not the app's host-side S3_ENDPOINT.
        endpoint: env.EGRESS_S3_ENDPOINT || env.S3_ENDPOINT || undefined,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKey: env.S3_ACCESS_KEY,
        secret: env.S3_SECRET_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      },
      templateUrl: env.EGRESS_TEMPLATE_URL || undefined,
    };
  }
  return new LiveKitMediaProvider(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, egress);
}

/** Create a LiveKit webhook receiver (verifies the signed Authorization header). */
export function webhookReceiverFromEnv(env: ServerEnv): WebhookReceiver | null {
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return null;
  return new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
}
