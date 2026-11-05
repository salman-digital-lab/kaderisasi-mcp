import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Compact signed blobs: base64url(JSON) + "." + base64url(HMAC-SHA256).
// Each blob carries its purpose, so a code can never be used as a token.
export type Purpose =
  "client" | "secret" | "request" | "code" | "access" | "refresh";

export class Signer {
  readonly #key: string;

  constructor(key: string) {
    this.#key = key;
  }

  #mac(purpose: Purpose, body: string): string {
    return createHmac("sha256", this.#key)
      .update(`${purpose}.${body}`)
      .digest("base64url");
  }

  sign(purpose: Purpose, payload: object, ttlSeconds?: number): string {
    const data: Record<string, unknown> = { ...payload, jti: randomUUID() };
    if (ttlSeconds !== undefined) {
      data.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    }
    const body = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${body}.${this.#mac(purpose, body)}`;
  }

  // Returns the payload, or null when the blob is forged, for another purpose,
  // or expired.
  verify<T extends object>(
    purpose: Purpose,
    token: string,
  ): (T & { jti: string; exp?: number }) | null {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) return null;
    const expected = Buffer.from(this.#mac(purpose, body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    try {
      const data = JSON.parse(Buffer.from(body, "base64url").toString());
      if (typeof data.exp === "number" && data.exp < Date.now() / 1000) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  // Deterministic value, used for confidential clients' secrets.
  derive(purpose: Purpose, value: string): string {
    return this.#mac(purpose, value);
  }
}
