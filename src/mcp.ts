import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  describeTable,
  listTables,
  QueryError,
  runQuery,
  type Db,
} from "./db.ts";

const INSTRUCTIONS = `Read-only access to the Salman ITB (BMKA) Kaderisasi database (PostgreSQL).
Kaderisasi is the member cadre-development platform. Data and UI terms are Indonesian.

Main tables:
- public_users (member accounts) + profiles (member biodata: name, gender, university, level, ...)
- activities (kegiatan/program) + activity_registrations (registrations, status, custom form answers)
- clubs (komunitas/UKM) + club_registrations, club_member_roles
- achievements (prestasi) + monthly_leaderboards, lifetime_leaderboards
- ruang_curhats (counseling requests; sensitive personal content)
- custom_forms, custom_form_responses (form builder)
- courses, course_lessons, course_lesson_progress (Kelas)
- issued_certificates, certificate_templates, certificate_approvals
- perintis_* (Perintis mentoring), p3ri_registrations (P3RI committee), talent_assessment_*
- announcements, calendar_events, urls (short links), tickets (admin role requests), admin_users
- reference data: universities, provinces, cities, countries

Workflow: call list_tables, then describe_table before writing SQL against an unfamiliar table.
Some secret columns (passwords, token hashes) are not readable; select columns explicitly
instead of SELECT * on admin_users, public_users and legacy_members.
Prefer aggregates (count, group by) over pulling many raw rows. Timestamps are timestamptz;
report times in Asia/Jakarta (WIB) for users.`;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const readOnlyHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createMcpServer(db: Db): McpServer {
  const server = new McpServer(
    { name: "kaderisasi", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List the readable tables in the Kaderisasi database with approximate row counts.",
      annotations: readOnlyHints,
    },
    async () => json(await listTables(db)),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Show a table's readable columns (name, type, nullability, default), foreign keys and indexes.",
      inputSchema: {
        table: z.string().min(1).max(63).describe("Table name, e.g. profiles"),
      },
      annotations: readOnlyHints,
    },
    async ({ table }) => {
      const description = await describeTable(db, table);
      return description
        ? json(description)
        : failure(`Table "${table}" does not exist or is not readable.`);
    },
  );

  server.registerTool(
    "query",
    {
      title: "Run read-only SQL",
      description: `Run one read-only PostgreSQL query (SELECT, WITH, VALUES or TABLE) and return {columns, rows, row_count, truncated}.
Runs in a read-only transaction with a ${Math.round(db.timeoutMs / 1000)}s timeout. At most ${db.maxRows} rows are returned; use aggregates or LIMIT.`,
      inputSchema: {
        sql: z.string().min(1).max(20_000).describe("A single SELECT query"),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(db.maxRows)
          .optional()
          .describe("Rows to return (default 200)"),
      },
      annotations: readOnlyHints,
    },
    async ({ sql, max_rows }) => {
      try {
        return json(await runQuery(db, sql, max_rows));
      } catch (error) {
        if (error instanceof QueryError) return failure(error.message);
        const pgError = error as { message?: string; code?: string };
        if (pgError.code) {
          return failure(
            `PostgreSQL error ${pgError.code}: ${pgError.message}`,
          );
        }
        throw error;
      }
    },
  );

  return server;
}
