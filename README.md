# kaderisasi-mcp

Read-only [MCP](https://modelcontextprotocol.io) server over the Kaderisasi
PostgreSQL database, so Claude can answer questions about Kaderisasi data
through a **custom connector** (claude.ai → Settings → Connectors → Add custom
connector).

- Connector URL: `https://<host>/mcp/<MCP_API_KEY>`
- Tools: `list_tables`, `describe_table`, `query` (one SELECT per call)
- Who can connect: whoever has the key (one key, one user, no login screen)

## How it stays read-only

It reads the database directly with the app's existing DB credentials. Two
locks keep it read-only:

1. **Read-only transaction.** Every call runs in `BEGIN READ ONLY … ROLLBACK`
   with `statement_timeout` and `search_path` set locally.
2. **Single SELECT.** `query` only accepts `SELECT`/`WITH`/`VALUES`/`TABLE`,
   wraps it in a subquery with a row cap, and sends it with the extended
   protocol, which rejects a second statement.

Only the `public` schema is exposed (`DB_SCHEMA`). Everything in it is
readable, including password hashes and token hashes.

## Auth

One API key, `MCP_API_KEY`, set in the deployment environment (never in the
code or git). Claude's connector dialog only takes a URL, so the key goes in the
path: `/mcp/<key>`. Clients that can send headers (Claude Code, MCP Inspector)
can call `/mcp` with `Authorization: Bearer <key>` instead. A missing or wrong
key gets `401`.

The URL is the secret: anyone who has it can read all data, including
counseling. Don't paste it in chats or tickets. To cut access, change
`MCP_API_KEY`, redeploy, and update the connector URL in Claude. Check that the
reverse proxy's access logs don't keep full request paths, or treat those logs
as secret.

## Setup

### 1. Deploy (Coolify)

Live as `kaderisasi-mcp-prod` (`khorpktuvc1aelfz3xzlavca`) in project
"Kaderisasi Web" → production on BMKA Main Server, at
`https://mcp-kaderisasi.salmanitb.com`. Pushing `main` doesn't auto-deploy;
run `coolify deploy uuid khorpktuvc1aelfz3xzlavca`. The image ships `curl`
because Coolify's health check needs it. Env vars are runtime-only.

For a new install:

Dockerfile build, container port `3020`, health check `GET /health`. Set the
variables from `.env.example`: the same `DB_*` values as the admin API, plus
`MCP_API_KEY` (`openssl rand -hex 32`).

### 2. Connect Claude

claude.ai → Settings → Connectors → Add custom connector → Name
`Kaderisasi`, URL `https://<host>/mcp/<MCP_API_KEY>`.

## Development

```sh
npm ci
cp .env.example .env   # fill in
npm run dev
npm test               # unit tests, no DB
npm run typecheck
npm run format:check
```

`npm run test:flow` runs the key check and every tool against a real database.
It needs `DB_*` in the environment and only reads.

Node 24 runs the TypeScript sources directly (type stripping); there is no
build step. Keep to erasable TypeScript syntax (no enums, namespaces or
parameter properties).
