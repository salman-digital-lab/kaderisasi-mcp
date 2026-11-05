import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";

const config = loadConfig();
const db = createDb(config);
const app = createApp(config, db);

const server = app.listen(config.PORT, () => {
  console.log(`kaderisasi-mcp listening on :${config.PORT}`);
});

function shutdown() {
  server.close(() => {
    db.pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
