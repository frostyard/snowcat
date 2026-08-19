import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

/**
 * Cloudflare Access at the edge (ADR-0063): the operator surface trusts the
 * `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie) only
 * after verifying it against the team's published RSA keys, its issuer, its
 * audience (the Access application's AUD tag), and its expiry. The verified
 * email is the person; Snowcat writes no login page and holds no OAuth
 * client. Keys are cached ten minutes and refreshed once on an unknown key
 * id. Anything that does not verify is simply "no identity" — the caller
 * decides what unauthenticated means.
 */
export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com` — the issuer and the certs origin. */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  audience: string;
  fetcher?: typeof fetch;
  clock?: () => Date;
  /** Test seam: cache lifetime in ms. */
  keyTtlMs?: number;
}

export interface AccessIdentity {
  email: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

const CERTS_PATH = "/cdn-cgi/access/certs";
const DEFAULT_KEY_TTL_MS = 10 * 60 * 1000;

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => Date;
  private readonly keyTtlMs: number;
  private readonly issuer: string;
  /** `https://<team>.cloudflareaccess.com`, for the logout redirect. */
  readonly teamDomain: string;

  constructor(private readonly config: AccessConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.clock = config.clock ?? (() => new Date());
    this.keyTtlMs = config.keyTtlMs ?? DEFAULT_KEY_TTL_MS;
    this.issuer = config.teamDomain.replace(/\/+$/, "");
    this.teamDomain = this.issuer;
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(this.issuer)) {
      throw new Error("SNOWCAT_ACCESS_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com");
    }
    if (!config.audience || !/^[0-9a-f]{16,128}$/i.test(config.audience)) {
      throw new Error("SNOWCAT_ACCESS_AUD must be the Access application's audience tag");
    }
  }

  /** The presented assertion from the request, header first, cookie second. */
  static presented(headers: Headers): string | undefined {
    const header = headers.get("Cf-Access-Jwt-Assertion");
    if (header) return header.trim();
    const cookie = headers.get("Cookie") ?? "";
    const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
    return match ? decodeURIComponent(match[1]!) : undefined;
  }

  async verify(assertion: string | undefined): Promise<AccessIdentity | undefined> {
    if (!assertion) return undefined;
    const parts = assertion.split(".");
    if (parts.length !== 3) return undefined;
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") return undefined;
    const key = await this.key(header.kid);
    if (!key) return undefined;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    let ok = false;
    try {
      ok = verifySignature("RSA-SHA256", signed, key, Buffer.from(parts[2]!, "base64url"));
    } catch {
      return undefined;
    }
    if (!ok) return undefined;
    const now = Math.floor(this.clock().getTime() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.issuer) return undefined;
    if (!audiences.includes(this.config.audience)) return undefined;
    if (typeof claims.exp !== "number" || claims.exp <= now) return undefined;
    if (typeof claims.iat === "number" && claims.iat > now + 300) return undefined;
    if (typeof claims.email !== "string" || !claims.email.includes("@")) return undefined;
    return {
      email: claims.email.toLowerCase(),
      subject: typeof claims.sub === "string" ? claims.sub : "",
      issuedAt: typeof claims.iat === "number" ? claims.iat : now,
      expiresAt: claims.exp,
    };
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const stale = this.clock().getTime() - this.fetchedAt > this.keyTtlMs;
    if (!this.keys.has(kid) || stale) await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.fetcher(`${this.issuer}${CERTS_PATH}`, { headers: { accept: "application/json" }, redirect: "error" });
      if (!response.ok) return;
      const body = (await response.json()) as { keys?: Jwk[] };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.n || !jwk.e) continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
        } catch {
          // Skip a malformed key; the rest still load.
        }
      }
      if (next.size > 0) {
        this.keys = next;
        this.fetchedAt = this.clock().getTime();
      }
    } catch {
      // Keep the cached keys; a verification with an unknown kid fails closed.
    }
  }
}

/** Reads the Access configuration from the environment; undefined when Access is not configured (local mode). */
export function accessConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): Pick<AccessConfig, "teamDomain" | "audience"> | undefined {
  const teamDomain = env.SNOWCAT_ACCESS_TEAM_DOMAIN;
  const audience = env.SNOWCAT_ACCESS_AUD;
  if (!teamDomain && !audience) return undefined;
  if (!teamDomain || !audience) throw new Error("SNOWCAT_ACCESS_TEAM_DOMAIN and SNOWCAT_ACCESS_AUD must be set together");
  return { teamDomain, audience };
}
