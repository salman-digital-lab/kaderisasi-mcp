import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryError, wrapQuery } from "../src/db.ts";
import { keyMatches } from "../src/app.ts";

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

test("keyMatches only accepts the exact key", () => {
  const key = "a".repeat(64);
  assert.equal(keyMatches(key, key), true);
  assert.equal(keyMatches(undefined, key), false);
  assert.equal(keyMatches("", key), false);
  assert.equal(keyMatches(key.slice(1), key), false);
  assert.equal(keyMatches(`${key}b`, key), false);
});
