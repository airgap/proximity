import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { GRANT_CAPS, type GrantCap, type ProximityGrant } from "@proximity/protocol";
import type { ServerEnv } from "@proximity/config";

/**
 * Bolt-on authorization. Proximity trusts ONE thing: a grant vouching for (identity + which
 * spaces the user may join), produced by the host authority (lyku, or an on-prem IdP/proxy).
 * Proximity never owns identity, groups, or billing — it only verifies and enforces.
 *
 * A verifier can produce a grant two ways:
 *   - fromRequest(req): from the HTTP upgrade headers (trusted_proxy) or an Authorization bearer.
 *   - fromToken(token): from the grant JWT the client passes in its `join` message.
 * `anonymous()` is non-null only in `open` (dev) mode.
 */
export interface GrantVerifier {
  readonly mode: string;
  fromRequest(req: Request): Promise<ProximityGrant | null>;
  fromToken(token: string): Promise<ProximityGrant | null>;
  anonymous(name: string): ProximityGrant | null;
}

const ALL_CAPS = [...GRANT_CAPS];

function coerceCaps(v: unknown): GrantCap[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const caps = arr.filter((c): c is GrantCap => (GRANT_CAPS as readonly string[]).includes(c));
  return caps.length ? caps : ALL_CAPS;
}

function coerceSpaces(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

/** Map arbitrary JWT claims to a grant. */
function payloadToGrant(
  p: JWTPayload,
  opts: { spacesClaim?: string; tenantClaim?: string } = {},
): ProximityGrant | null {
  if (!p.sub) return null;
  const spacesRaw = opts.spacesClaim ? p[opts.spacesClaim] : p.spaces;
  const spaces = coerceSpaces(spacesRaw);
  return {
    sub: String(p.sub),
    name: String(p.name ?? p.email ?? p.sub),
    avatar: p.avatar ? String(p.avatar) : undefined,
    tenant: opts.tenantClaim
      ? p[opts.tenantClaim]
        ? String(p[opts.tenantClaim])
        : undefined
      : typeof p.tenant === "string"
        ? p.tenant
        : undefined,
    // For OIDC without an explicit spaces claim, a valid token means "any space" (auth IS the gate).
    spaces: spaces.length ? spaces : opts.spacesClaim ? [] : ["*"],
    caps: coerceCaps(p.caps),
    exp: typeof p.exp === "number" ? p.exp : undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export class OpenVerifier implements GrantVerifier {
  readonly mode = "open";
  async fromRequest(): Promise<null> {
    return null;
  }
  async fromToken(): Promise<null> {
    return null;
  }
  anonymous(name: string): ProximityGrant {
    return { sub: `anon_${crypto.randomUUID()}`, name: name || "Guest", spaces: ["*"], caps: ALL_CAPS };
  }
}

class SharedSecretVerifier implements GrantVerifier {
  readonly mode = "shared_secret";
  private readonly key: Uint8Array;
  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }
  async fromRequest(req: Request): Promise<ProximityGrant | null> {
    const auth = req.headers.get("authorization");
    return auth?.startsWith("Bearer ") ? this.fromToken(auth.slice(7)) : null;
  }
  async fromToken(token: string): Promise<ProximityGrant | null> {
    try {
      const { payload } = await jwtVerify(token, this.key);
      return payloadToGrant(payload);
    } catch {
      return null;
    }
  }
  anonymous(): null {
    return null;
  }
}

class OidcVerifier implements GrantVerifier {
  readonly mode = "oidc";
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    jwksUri: string,
    private readonly issuer: string | undefined,
    private readonly audience: string | undefined,
    private readonly spacesClaim: string | undefined,
    private readonly tenantClaim: string | undefined,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
  }
  async fromRequest(req: Request): Promise<ProximityGrant | null> {
    const auth = req.headers.get("authorization");
    return auth?.startsWith("Bearer ") ? this.fromToken(auth.slice(7)) : null;
  }
  async fromToken(token: string): Promise<ProximityGrant | null> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
      });
      return payloadToGrant(payload, {
        spacesClaim: this.spacesClaim,
        tenantClaim: this.tenantClaim,
      });
    } catch {
      return null;
    }
  }
  anonymous(): null {
    return null;
  }
}

class TrustedProxyVerifier implements GrantVerifier {
  readonly mode = "trusted_proxy";
  constructor(
    private readonly userHeader: string,
    private readonly nameHeader: string,
    private readonly spacesHeader: string,
    private readonly tenantHeader: string,
  ) {}
  async fromRequest(req: Request): Promise<ProximityGrant | null> {
    const user = req.headers.get(this.userHeader);
    if (!user) return null;
    const spaces = coerceSpaces(req.headers.get(this.spacesHeader));
    return {
      sub: user,
      name: req.headers.get(this.nameHeader) ?? user,
      tenant: req.headers.get(this.tenantHeader) ?? undefined,
      spaces: spaces.length ? spaces : ["*"], // network/proxy is the gate
      caps: ALL_CAPS,
    };
  }
  async fromToken(): Promise<null> {
    return null;
  }
  anonymous(): null {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory + policy helpers
// ---------------------------------------------------------------------------

export function verifierFromEnv(env: ServerEnv): GrantVerifier {
  switch (env.PROXIMITY_AUTH_MODE) {
    case "shared_secret": {
      if (!env.PROXIMITY_GRANT_SECRET) {
        throw new Error("PROXIMITY_AUTH_MODE=shared_secret requires PROXIMITY_GRANT_SECRET");
      }
      return new SharedSecretVerifier(env.PROXIMITY_GRANT_SECRET);
    }
    case "oidc": {
      if (!env.OIDC_JWKS_URI) throw new Error("PROXIMITY_AUTH_MODE=oidc requires OIDC_JWKS_URI");
      return new OidcVerifier(
        env.OIDC_JWKS_URI,
        env.OIDC_ISSUER,
        env.OIDC_AUDIENCE,
        env.OIDC_SPACES_CLAIM,
        env.OIDC_TENANT_CLAIM,
      );
    }
    case "trusted_proxy":
      return new TrustedProxyVerifier(
        env.TRUSTED_PROXY_USER_HEADER,
        env.TRUSTED_PROXY_NAME_HEADER,
        env.TRUSTED_PROXY_SPACES_HEADER,
        env.TRUSTED_PROXY_TENANT_HEADER,
      );
    default:
      return new OpenVerifier();
  }
}

/** Whether a grant permits joining the requested space id. */
export function grantAllowsSpace(grant: ProximityGrant, spaceId: string): boolean {
  return grant.spaces.includes("*") || grant.spaces.includes(spaceId);
}

/** Tenant-scoped internal space key so one deployment can serve many orgs safely. */
export function tenantScopedKey(grant: ProximityGrant, spaceId: string): string {
  return grant.tenant ? `${grant.tenant}:${spaceId}` : spaceId;
}

/** Mint a shared-secret grant (used by tests and on-prem/dev token issuers). */
export async function signGrant(
  grant: ProximityGrant,
  secret: string,
  ttlSeconds = 900,
): Promise<string> {
  return new SignJWT({
    name: grant.name,
    ...(grant.avatar ? { avatar: grant.avatar } : {}),
    tenant: grant.tenant,
    spaces: grant.spaces,
    caps: grant.caps,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(grant.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}
