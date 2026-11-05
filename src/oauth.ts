import express from "express";
import type { Response, Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Config } from "./config.ts";
import { readOnly, type Db } from "./db.ts";
import { Signer } from "./tokens.ts";

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL = 5 * 60;
const REQUEST_TTL = 10 * 60;
const ADMIN_CACHE_MS = 60_000;
export const SCOPE = "read";

export type Admin = { id: number; email: string };

// Only active Super Admins may connect: they can already read everything in
// the admin dashboard, which is what this connector exposes.
export class AdminDirectory {
  readonly #db: Db;
  readonly #cache = new Map<number, { admin: Admin | null; at: number }>();

  constructor(db: Db) {
    this.#db = db;
  }

  async findForGoogle(subject: string, email: string): Promise<Admin | null> {
    const id = await readOnly(this.#db, async (client) => {
      const identity = await client.query({
        text: `SELECT admin_user_id FROM admin_auth_identities
               WHERE provider = 'google' AND provider_subject = $1`,
        values: [subject],
      });
      if (identity.rowCount) return identity.rows[0].admin_user_id as number;
      const user = await client.query({
        text: `SELECT id FROM admin_users WHERE normalized_email = $1`,
        values: [email.trim().toLowerCase()],
      });
      return user.rowCount ? (user.rows[0].id as number) : null;
    });
    return id === null ? null : this.activeSuperAdmin(id, true);
  }

  async activeSuperAdmin(id: number, fresh = false): Promise<Admin | null> {
    const cached = this.#cache.get(id);
    if (!fresh && cached && Date.now() - cached.at < ADMIN_CACHE_MS) {
      return cached.admin;
    }
    const admin = await readOnly(this.#db, async (client) => {
      const result = await client.query({
        text: `SELECT id, email FROM admin_users
               WHERE id = $1 AND is_active
                 AND (role_code = 'super_admin'
                      OR 'super_admin' = ANY(additional_role_codes))`,
        values: [id],
      });
      return result.rowCount ? (result.rows[0] as Admin) : null;
    });
    this.#cache.set(id, { admin, at: Date.now() });
    return admin;
  }
}

export type GoogleIdentity = { subject: string; email: string };
export type GoogleVerifier = (credential: string) => Promise<GoogleIdentity>;

export function googleVerifier(clientId: string): GoogleVerifier {
  const keys = createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
  );
  return async (credential) => {
    const { payload } = await jwtVerify(credential, keys, {
      issuer: ["accounts.google.com", "https://accounts.google.com"],
      audience: clientId,
      clockTolerance: 300,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      payload.email_verified !== true
    ) {
      throw new Error("Google account has no verified email");
    }
    return { subject: payload.sub, email: payload.email.toLowerCase() };
  };
}

type ClientBlob = {
  r: string[];
  n?: string;
  m?: string;
  g?: string[];
  t?: string[];
};
type RequestBlob = {
  c: string;
  r: string;
  s?: string;
  cc: string;
  rs?: string;
};
type CodeBlob = { c: string; r: string; cc: string; rs?: string; a: number };
type TokenBlob = { c: string; a: number; rs?: string };

export class KaderisasiOAuthProvider implements OAuthServerProvider {
  readonly #signer: Signer;
  readonly #config: Config;
  readonly #admins: AdminDirectory;
  readonly #usedCodes = new Map<string, number>();

  constructor(config: Config, signer: Signer, admins: AdminDirectory) {
    this.#config = config;
    this.#signer = signer;
    this.#admins = admins;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.#client(clientId),
      registerClient: (meta) => {
        for (const uri of meta.redirect_uris) {
          if (!this.redirectAllowed(String(uri))) {
            throw new InvalidClientMetadataError(
              `redirect_uri host is not allowed: ${uri}`,
            );
          }
        }
        // Clients live inside their own signed id, so nothing is stored.
        const blob: ClientBlob = {
          r: meta.redirect_uris.map(String),
          n: meta.client_name,
          m: meta.token_endpoint_auth_method,
          g: meta.grant_types,
          t: meta.response_types,
        };
        const id = this.#signer.sign("client", blob);
        return this.#client(id)!;
      },
    };
  }

  redirectAllowed(uri: string): boolean {
    try {
      const url = new URL(uri);
      const host = url.hostname.toLowerCase();
      const local = host === "localhost" || host === "127.0.0.1";
      if (url.protocol !== "https:" && !local) return false;
      return this.#config.allowedRedirectHosts.includes(host);
    } catch {
      return false;
    }
  }

  #client(clientId: string): OAuthClientInformationFull | undefined {
    const blob = this.#signer.verify<ClientBlob>("client", clientId);
    if (!blob) return undefined;
    const method = blob.m ?? "client_secret_basic";
    return {
      client_id: clientId,
      client_name: blob.n,
      redirect_uris: blob.r,
      token_endpoint_auth_method: method,
      grant_types: blob.g ?? ["authorization_code", "refresh_token"],
      response_types: blob.t ?? ["code"],
      ...(method === "none"
        ? {}
        : {
            client_secret: this.#signer.derive("secret", clientId),
            client_secret_expires_at: 0,
          }),
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const request = this.#signer.sign(
      "request",
      {
        c: client.client_id,
        r: params.redirectUri,
        s: params.state,
        cc: params.codeChallenge,
        rs: params.resource?.href,
      } satisfies RequestBlob,
      REQUEST_TTL,
    );
    res
      .status(200)
      .type("html")
      .setHeader("Cache-Control", "no-store")
      .send(signInPage(this.#config.GOOGLE_CLIENT_ID, request));
  }

  // Called by the sign-in page after Google returns an ID token.
  async completeSignIn(
    requestToken: string,
    identity: GoogleIdentity,
  ): Promise<{ redirect: string } | { error: string }> {
    const request = this.#signer.verify<RequestBlob>("request", requestToken);
    if (!request)
      return { error: "Sesi masuk kedaluwarsa. Ulangi dari Claude." };
    const admin = await this.#admins.findForGoogle(
      identity.subject,
      identity.email,
    );
    if (!admin) {
      return {
        error: `${identity.email} bukan Super Admin aktif, jadi tidak dapat menghubungkan Claude ke data Kaderisasi.`,
      };
    }
    const code = this.#signer.sign(
      "code",
      {
        c: request.c,
        r: request.r,
        cc: request.cc,
        rs: request.rs,
        a: admin.id,
      } satisfies CodeBlob,
      CODE_TTL,
    );
    const target = new URL(request.r);
    target.searchParams.set("code", code);
    if (request.s !== undefined) target.searchParams.set("state", request.s);
    return { redirect: target.href };
  }

  #code(client: OAuthClientInformationFull, code: string) {
    const blob = this.#signer.verify<CodeBlob>("code", code);
    if (!blob || blob.c !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return blob;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    return this.#code(client, code).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const blob = this.#code(client, code);
    if (redirectUri !== undefined && redirectUri !== blob.r) {
      throw new InvalidGrantError("redirect_uri does not match");
    }
    this.#useCodeOnce(blob.jti, blob.exp ?? 0);
    return this.#issue(client.client_id, blob.a, blob.rs);
  }

  #useCodeOnce(jti: string, exp: number) {
    const now = Date.now() / 1000;
    for (const [id, until] of this.#usedCodes) {
      if (until < now) this.#usedCodes.delete(id);
    }
    if (this.#usedCodes.has(jti)) {
      throw new InvalidGrantError("Authorization code already used");
    }
    this.#usedCodes.set(jti, exp);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const blob = this.#signer.verify<TokenBlob>("refresh", refreshToken);
    if (!blob || blob.c !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    return this.#issue(client.client_id, blob.a, blob.rs);
  }

  async #issue(
    clientId: string,
    adminId: number,
    resource?: string,
  ): Promise<OAuthTokens> {
    if (!(await this.#admins.activeSuperAdmin(adminId, true))) {
      throw new InvalidGrantError("Account is no longer an active Super Admin");
    }
    const payload: TokenBlob = { c: clientId, a: adminId, rs: resource };
    return {
      access_token: this.#signer.sign("access", payload, ACCESS_TTL),
      token_type: "bearer",
      expires_in: ACCESS_TTL,
      refresh_token: this.#signer.sign("refresh", payload, REFRESH_TTL),
      scope: SCOPE,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const blob = this.#signer.verify<TokenBlob>("access", token);
    if (!blob) throw new InvalidTokenError("Invalid or expired token");
    const admin = await this.#admins.activeSuperAdmin(blob.a);
    if (!admin) throw new InvalidTokenError("Account is no longer allowed");
    return {
      token,
      clientId: blob.c,
      scopes: [SCOPE],
      expiresAt: blob.exp,
      resource: blob.rs ? new URL(blob.rs) : undefined,
      extra: { adminId: admin.id, email: admin.email },
    };
  }
}

export function signInRouter(
  provider: KaderisasiOAuthProvider,
  verifyGoogle: GoogleVerifier,
): Router {
  const router = express.Router();
  router.post(
    "/oauth/google",
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const credential = String(req.body?.credential ?? "");
      const request = String(req.body?.request ?? "");
      let identity: GoogleIdentity;
      try {
        identity = await verifyGoogle(credential);
      } catch {
        res
          .status(400)
          .type("html")
          .send(errorPage("Login Google tidak valid."));
        return;
      }
      try {
        const result = await provider.completeSignIn(request, identity);
        if ("error" in result) {
          res.status(403).type("html").send(errorPage(result.error));
          return;
        }
        res.redirect(302, result.redirect);
      } catch (error) {
        console.error("sign-in failed", error);
        res
          .status(500)
          .type("html")
          .send(errorPage("Terjadi kesalahan server."));
      }
    },
  );
  return router;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

const pageStyle = `
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #1f1f1f;
         display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  main { background: #fff; border-radius: 12px; padding: 32px; max-width: 420px;
         margin: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { line-height: 1.5; color: #555; }
`;

function signInPage(clientId: string, request: string): string {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hubungkan Claude ke Kaderisasi</title>
<style>${pageStyle}</style>
<script src="https://accounts.google.com/gsi/client" async></script>
</head><body><main>
<h1>Hubungkan Claude ke Kaderisasi</h1>
<p>Claude akan dapat <strong>membaca</strong> seluruh data Kaderisasi (tidak dapat mengubah apa pun).
Hanya Super Admin aktif yang dapat masuk.</p>
<div id="g_id_onload" data-client_id="${escapeHtml(clientId)}"
  data-callback="onGoogleCredential" data-auto_prompt="false"></div>
<div class="g_id_signin" data-type="standard" data-text="signin_with" data-locale="id"></div>
<form id="f" method="post" action="/oauth/google">
  <input type="hidden" name="credential">
  <input type="hidden" name="request" value="${escapeHtml(request)}">
</form>
<script>
  function onGoogleCredential(response) {
    var form = document.getElementById("f");
    form.credential.value = response.credential;
    form.submit();
  }
</script>
</main></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidak dapat masuk</title><style>${pageStyle}</style></head>
<body><main><h1>Tidak dapat masuk</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
