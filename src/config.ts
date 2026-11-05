import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3020),
  // Public HTTPS origin of this server, e.g. https://mcp-kaderisasi.salmanitb.com
  PUBLIC_URL: z.url(),
  // Signs OAuth clients, codes and tokens. Rotating it signs everyone out.
  MCP_SIGNING_KEY: z.string().min(32),
  // Same Google client as the admin dashboard (ID-token sign-in).
  GOOGLE_CLIENT_ID: z.string().min(1),
  // Hosts allowed as OAuth redirect targets.
  MCP_ALLOWED_REDIRECT_HOSTS: z.string().default("claude.ai,claude.com"),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_DATABASE: z.string().min(1),
  DB_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .default("public"),
  QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  QUERY_MAX_ROWS: z.coerce.number().int().min(1).default(1000),
});

export type Config = z.infer<typeof Env> & { allowedRedirectHosts: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  return {
    ...parsed.data,
    PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/+$/, ""),
    allowedRedirectHosts: parsed.data.MCP_ALLOWED_REDIRECT_HOSTS.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
