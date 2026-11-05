// End-to-end MCP flow against a real database. Needs DB_* env (any database
// with the Kaderisasi schema). Only reads. Run: npm run test:flow
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";

const skip = !process.env.DB_HOST;
const key = "k".repeat(48);
let server: Server;
let db: Db;
let base = "";

before(async () => {
  if (skip) return;
  const config = loadConfig({ ...process.env, MCP_API_KEY: key });
  db = createDb(config);
  server = createApp(config, db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

async function rpc(path: string, method: string, params = {}, auth?: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: res.status,
    body: res.status === 200 ? await res.json() : null,
  };
}

test("the key is required", { skip }, async () => {
  assert.equal((await rpc("/mcp", "tools/list")).status, 401);
  assert.equal((await rpc("/mcp/wrong", "tools/list")).status, 401);
  assert.equal(
    (await rpc("/mcp", "tools/list", {}, "Bearer wrong")).status,
    401,
  );
  assert.equal(
    (await rpc("/mcp", "tools/list", {}, `Bearer ${key}`)).status,
    200,
  );
  const get = await fetch(`${base}/mcp/${key}`);
  assert.equal(get.status, 405);
});

test("tools work and stay read-only", { skip }, async (t) => {
  const path = `/mcp/${key}`;
  const list = await rpc(path, "tools/list");
  const names = list.body.result.tools.map((x: { name: string }) => x.name);
  assert.deepEqual(names.sort(), ["describe_table", "list_tables", "query"]);

  const call = async (name: string, args = {}) => {
    const r = await rpc(path, "tools/call", { name, arguments: args });
    return r.body.result as { isError?: boolean; content: { text: string }[] };
  };

  await t.test("list_tables and describe_table", async () => {
    const tables = JSON.parse((await call("list_tables")).content[0].text);
    assert.ok(tables.some((x: { table: string }) => x.table === "profiles"));
    const profiles = JSON.parse(
      (await call("describe_table", { table: "profiles" })).content[0].text,
    );
    assert.ok(profiles.columns.length > 3);
    assert.equal(
      (await call("describe_table", { table: "nope" })).isError,
      true,
    );
  });

  await t.test("query returns rows and caps them", async () => {
    const r = JSON.parse(
      (await call("query", { sql: "select count(*) as n from profiles;" }))
        .content[0].text,
    );
    assert.deepEqual(r.columns, ["n"]);
    const capped = JSON.parse(
      (
        await call("query", {
          sql: "select g from generate_series(1, 50) g",
          max_rows: 10,
        })
      ).content[0].text,
    );
    assert.equal(capped.row_count, 10);
    assert.equal(capped.truncated, true);
  });

  await t.test("writes and statement tricks are refused", async () => {
    for (const sql of [
      "delete from urls where false",
      "update countries set name = name where false",
      "select 1) q; delete from urls where false; select * from (select 1",
      "with x as (delete from urls where false returning 1) select * from x",
      "select set_config('transaction_read_only', 'off', false)",
      "select nextval('urls_id_seq')",
    ]) {
      assert.equal((await call("query", { sql })).isError, true, sql);
    }
  });
});
