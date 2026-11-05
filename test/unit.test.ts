import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryError, wrapQuery } from "../src/db.ts";
import { Signer } from "../src/tokens.ts";

test("wrapQuery accepts one read statement and adds a row cap", () => {
  assert.equal(
    wrapQuery("select 1;  ", 5),
    "SELECT * FROM (\nselect 1\n) AS mcp_query LIMIT 6",
  );
  for (const sql of [
    "WITH x AS (select 1) select * from x",
    "values (1)",
    "table profiles",
    "-- note\nselect 1",
    "/* a */ select 1",
  ]) {
    assert.doesNotThrow(() => wrapQuery(sql, 1), sql);
  }
  for (const sql of [
    "delete from urls",
    "update x set y = 1",
    "insert into x values (1)",
    "drop table x",
    "set role postgres",
    "copy x to stdout",
    "explain select 1",
  ]) {
    assert.throws(() => wrapQuery(sql, 1), QueryError, sql);
  }
});

test("Signer rejects forged, cross-purpose and expired blobs", () => {
  const signer = new Signer("k".repeat(32));
  const code = signer.sign("code", { a: 1 }, 60);
  assert.equal(signer.verify<{ a: number }>("code", code)?.a, 1);
  assert.equal(signer.verify("access", code), null, "purpose is bound");
  assert.equal(new Signer("x".repeat(32)).verify("code", code), null);
  const [body, mac] = code.split(".");
  const forged = Buffer.from(JSON.stringify({ a: 2 })).toString("base64url");
  assert.equal(signer.verify("code", `${forged}.${mac}`), null);
  assert.equal(signer.verify("code", `${body}.${mac}.x`), null);
  assert.equal(signer.verify("code", signer.sign("code", {}, -1)), null);
});
