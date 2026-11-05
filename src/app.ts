import express from "express";
import type { Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { createMcpServer } from "./mcp.ts";
import {
  AdminDirectory,
  KaderisasiOAuthProvider,
  SCOPE,
  signInRouter,
  type GoogleVerifier,
} from "./oauth.ts";
import { Signer } from "./tokens.ts";

export function createApp(
  config: Config,
  db: Db,
  verifyGoogle: GoogleVerifier,
): Express {
  const app = express();
  app.disable("x-powered-by");
  // Coolify's proxy terminates TLS; rate limits key on the client address.
  app.set("trust proxy", 1);

  const provider = new KaderisasiOAuthProvider(
    config,
    new Signer(config.MCP_SIGNING_KEY),
    new AdminDirectory(db),
  );
  const issuer = new URL(config.PUBLIC_URL);
  const mcpUrl = new URL("/mcp", issuer);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "Kaderisasi (read-only)",
    }),
  );
  app.use(signInRouter(provider, verifyGoogle));

  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless: a fresh server and transport per request.
  app.post("/mcp", auth, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createMcpServer(db);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("mcp request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });
  app.all("/mcp", auth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  });

  return app;
}
