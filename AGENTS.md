# kaderisasi-mcp rules

Read-only MCP server for a Claude custom connector over the shared Kaderisasi
PostgreSQL database. When working in the full workspace, also read `../AGENTS.md`.
`README.md` explains auth, the three read-only locks and setup.

- **Never add a tool that writes**, calls the admin/web APIs with side effects,
  or reads outside `DB_SCHEMA`. All database access goes through `readOnly()`
  in `src/db.ts`.
- The DB user must be `kaderisasi_mcp` from `sql/grant-readonly.sql`, never the
  schema owner. Schema changes come from Ace migrations in `../kaderisasi-admin-be`;
  after one adds a table or a secret-looking column, re-run (and if needed extend)
  `sql/grant-readonly.sql`.
- Only active Super Admins may sign in (`AdminDirectory` in `src/oauth.ts`).
  Do not widen this without the user's say-so: the connector reads counseling
  and member personal data.
- The server is stateless: OAuth clients, codes and tokens are HMAC-signed
  (`src/tokens.ts`). Do not add a write-capable store for them.
- Node 24 runs `.ts` directly: erasable syntax only, `.ts` import extensions.
- Checks: `npm run typecheck`, `npm test`, `npm run format:check`.
- End-to-end flow: `npm run test:flow` with `DB_*` and `TEST_SUPER_ADMIN_EMAIL`.
