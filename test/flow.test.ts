// End-to-end OAuth + MCP flow against a real database, with Google sign-in
// stubbed. Needs DB_* env (any database with the Kaderisasi schema) and
// TEST_SUPER_ADMIN_EMAIL: an active Super Admin in that database.
// Run: node --env-file=<env file> --test test/flow.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";
import type { GoogleIdentity } from "../src/oauth.ts";

const superAdmin = process.env.TEST_SUPER_ADMIN_EMAIL;
const skip = !process.env.DB_HOST || !superAdmin;

let server: Server;
let db: Db;
let base = "";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

before(async () => {
  if (skip) return;
  // Reserve a port first so PUBLIC_URL matches what the test calls.
  const probe = (await import("node:net")).createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  base = `http://localhost:${port}`;
  const config = loadConfig({
    ...process.env,
    PORT: String(port),
    PUBLIC_URL: base,
    MCP_SIGNING_KEY: randomBytes(32).toString("hex"),
    GOOGLE_CLIENT_ID: "test-client",
  });
  db = createDb(config);
  // The stub treats the credential as "subject|email".
  const verifyGoogle = async (credential: string): Promise<GoogleIdentity> => {
    const [subject, email] = credential.split("|");
    if (!subject || !email) throw new Error("bad credential");
    return { subject, email };
  };
  server = createApp(config, db, verifyGoogle).listen(port);
});

after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await db.pool.end();
});

async function register(): Promise<{
  client_id: string;
  client_secret?: string;
}> {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function signIn(clientId: string, credential: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "read",
  }).toString();
  const page = await (await fetch(authorize)).text();
  const request = /name="request" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(request, "sign-in page carries the signed request");
  const res = await fetch(`${base}/oauth/google`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ credential, request }).toString(),
  });
  return { res, verifier };
}

async function token(body: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function rpc(accessToken: string | null, method: string, params = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: res.status,
    body: res.status === 200 ? await res.json() : null,
  };
}

test("full read-only flow", { skip }, async (t) => {
  const meta = await (
    await fetch(`${base}/.well-known/oauth-authorization-server`)
  ).json();
  assert.equal(meta.registration_endpoint, `${base}/register`);
  const resourceMeta = await fetch(
    `${base}/.well-known/oauth-protected-resource/mcp`,
  );
  assert.equal(resourceMeta.status, 200);

  assert.equal((await rpc(null, "tools/list")).status, 401);
  assert.equal((await rpc("forged.token", "tools/list")).status, 401);

  const client = await register();
  const { res, verifier } = await signIn(
    client.client_id,
    `sub-${Date.now()}|${superAdmin}`,
  );
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code")!;

  const exchange = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.client_id,
  };
  const wrongVerifier = await token({
    ...exchange,
    code_verifier: "x".repeat(43),
  });
  assert.equal(wrongVerifier.status, 400);
  const tokens = await (await token(exchange)).json();
  assert.ok(tokens.access_token);
  assert.equal((await token(exchange)).status, 400, "code is single-use");

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  });
  assert.equal(refreshed.status, 200);

  const access = tokens.access_token as string;
  await t.test("tools are listed as read-only", async () => {
    const list = await rpc(access, "tools/list");
    const names = list.body.result.tools.map((x: { name: string }) => x.name);
    assert.deepEqual(names.sort(), ["describe_table", "list_tables", "query"]);
    for (const tool of list.body.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
    }
  });

  const call = async (name: string, args = {}) => {
    const r = await rpc(access, "tools/call", { name, arguments: args });
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
      const result = await call("query", { sql });
      assert.equal(result.isError, true, sql);
    }
  });
});

test("non Super Admins cannot sign in", { skip }, async () => {
  const client = await register();
  const { res } = await signIn(
    client.client_id,
    `sub-${Date.now()}|nobody-${Date.now()}@example.com`,
  );
  assert.equal(res.status, 403);
});

test(
  "redirects to unknown hosts are refused at registration",
  { skip },
  async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(res.status, 400);
  },
);
