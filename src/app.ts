import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { createMcpServer } from "./mcp.ts";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Constant-time comparison of the given key with the configured one.
export function keyMatches(given: string | undefined, expected: string) {
  return (
    given !== undefined && timingSafeEqual(digest(given), digest(expected))
  );
}

function bearer(req: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

export function createApp(config: Config, db: Db): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Claude's connector dialog only takes a URL, so the key travels in the
  // path: /mcp/<key>. Clients that can send headers may use /mcp with
  // "Authorization: Bearer <key>" instead.
  const authorized = (req: Request) =>
    keyMatches(
      typeof req.params.key === "string" ? req.params.key : bearer(req),
      config.MCP_API_KEY,
    );

  const handle = async (req: Request, res: Response) => {
    if (!authorized(req)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    if (req.method !== "POST") {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        });
      return;
    }
    // Stateless: a fresh server and transport per request.
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
  };

  const json = express.json({ limit: "1mb" });
  app.all("/mcp", json, handle);
  app.all("/mcp/:key", json, handle);

  return app;
}
