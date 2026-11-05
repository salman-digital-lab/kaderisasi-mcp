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
- Auth is one API key (`MCP_API_KEY`, env only, never committed), sent in the
  path `/mcp/<key>` or as a Bearer header. Never log request paths: the key is
  in them.
- The server is stateless and keeps no store of its own.
- Node 24 runs `.ts` directly: erasable syntax only, `.ts` import extensions.
- Checks: `npm run typecheck`, `npm test`, `npm run format:check`.
- End-to-end flow: `npm run test:flow` with `DB_*` in the environment.
