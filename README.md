# kaderisasi-mcp

Read-only [MCP](https://modelcontextprotocol.io) server over the Kaderisasi
PostgreSQL database, so Claude can answer questions about Kaderisasi data
through a **custom connector** (claude.ai → Settings → Connectors → Add custom
connector).

- Connector URL: `https://<PUBLIC_URL host>/mcp`
- Tools: `list_tables`, `describe_table`, `query` (one SELECT per call)
- Who can connect: active **Super Admins** only, through Google sign-in
  (same Google client as the admin dashboard)

## How it stays read-only

Three independent locks:

1. **Database user.** `kaderisasi_mcp` has only `SELECT` grants
   (`sql/grant-readonly.sql`), `default_transaction_read_only = on` and a
   statement timeout. Secrets are not granted: `admin_refresh_tokens`, and
   every `password` / `*_token` / `token_hash` / `secret` column.
2. **Read-only transaction.** Every call runs in `BEGIN READ ONLY … ROLLBACK`
   with `statement_timeout` and `search_path` set locally.
3. **Single SELECT.** `query` only accepts `SELECT`/`WITH`/`VALUES`/`TABLE`,
   wraps it in a subquery with a row cap, and sends it with the extended
   protocol, which rejects a second statement.

Only the `public` schema is exposed (`DB_SCHEMA`).

## Auth

The server is its own OAuth 2.1 authorization server (dynamic client
registration + PKCE), as Claude connectors require. It stores nothing:
clients, codes and tokens are HMAC-signed with `MCP_SIGNING_KEY`.

- Sign-in page: Google Identity Services button → ID token verified against
  Google's keys → admin looked up by Google identity, then by email.
- Must be an active admin with `super_admin` as primary or additional role.
  This is re-checked on every token refresh and at least every minute while
  tokens are used, so deactivating the admin or removing the role cuts access.
- Access tokens last 1 hour, refresh tokens 30 days. Rotating
  `MCP_SIGNING_KEY` signs every client out.
- Redirect URIs must be on `MCP_ALLOWED_REDIRECT_HOSTS` (default
  `claude.ai,claude.com`).

## Setup

### 1. Database user (once per database, by the DB owner)

```sql
CREATE ROLE kaderisasi_mcp LOGIN PASSWORD '<generated>' NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
```

Then run `sql/grant-readonly.sql` as the owner. **Re-run it after migrations
that add tables or columns** (new tables are invisible until then, and a new
secret column is hidden only if its name matches the pattern; check the list in
the script when adding one).

### 2. Google client

Add the server's origin (for example `https://mcp-kaderisasi.salmanitb.com`)
to **Authorized JavaScript origins** of the admin dashboard's Google OAuth
client. No client secret is needed.

### 3. Deploy (Coolify)

Dockerfile build, container port `3020`, health check `GET /health`. Set the
variables from `.env.example`; use the `kaderisasi_mcp` DB user, never the
owner account. `MCP_SIGNING_KEY`: `openssl rand -hex 32`.

### 4. Connect Claude

claude.ai → Settings → Connectors → Add custom connector → Name
`Kaderisasi`, URL `https://<host>/mcp` → sign in with Google as a Super Admin.

## Development

```sh
npm ci
cp .env.example .env   # fill in; for local use PUBLIC_URL=http://localhost:3020
npm run dev
npm test               # unit tests, no DB
npm run typecheck
npm run format:check
```

`npm run test:flow` runs the full OAuth + tool flow against a real database
with Google sign-in stubbed. It needs `DB_*` and `TEST_SUPER_ADMIN_EMAIL` (an
active Super Admin there) in the environment. It only reads.

Node 24 runs the TypeScript sources directly (type stripping); there is no
build step. Keep to erasable TypeScript syntax (no enums, namespaces or
parameter properties).
