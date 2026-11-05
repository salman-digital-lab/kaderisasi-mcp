import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3020),
  // The one key that unlocks the connector. Connector URL: <host>/mcp/<key>.
  // Long and URL-safe; generate with: openssl rand -hex 32
  MCP_API_KEY: z.string().regex(/^[A-Za-z0-9_-]{32,}$/),
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

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${fields}`);
  }
  return parsed.data;
}
