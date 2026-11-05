-- Grants the kaderisasi_mcp database user SELECT on the public schema,
-- except secrets. Safe to re-run; run it again after migrations that add
-- tables (new tables are not readable until then).
--
-- Run as the database owner or a superuser, once per database
-- (dev and prod separately). Create the login first, with a generated password:
--
--   CREATE ROLE kaderisasi_mcp LOGIN PASSWORD '<generated>' NOSUPERUSER
--     NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--
-- Hidden:
--   * tables: admin_refresh_tokens, adonis_schema, adonis_schema_versions
--   * columns named like password / secret / token / token_hash / remember_me_token
-- Everything else in public is readable, including member data and counseling.

ALTER ROLE kaderisasi_mcp SET default_transaction_read_only = on;
ALTER ROLE kaderisasi_mcp SET statement_timeout = '20s';
ALTER ROLE kaderisasi_mcp SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE kaderisasi_mcp SET search_path = public;
ALTER ROLE kaderisasi_mcp CONNECTION LIMIT 10;

DO $$
DECLARE
  reader constant text := 'kaderisasi_mcp';
  hidden_tables constant text[] := ARRAY[
    'admin_refresh_tokens', 'adonis_schema', 'adonis_schema_versions'
  ];
  hidden_columns constant text :=
    '^(password|.*_password|secret|.*_secret|token|.*_token|token_hash|.*_token_hash|remember_me_token)$';
  t record;
  readable text;
  hidden int;
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), reader);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', reader);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', reader);

  FOR t IN
    SELECT c.oid, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relname
  LOOP
    -- Start from nothing: table and column privileges are separate.
    EXECUTE format('REVOKE ALL ON public.%I FROM %I', t.relname, reader);
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum),
           count(*) FILTER (WHERE a.attname ~* hidden_columns)
      INTO readable, hidden
    FROM pg_attribute a
    WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped;
    IF readable IS NOT NULL THEN
      EXECUTE format('REVOKE ALL (%s) ON public.%I FROM %I', readable, t.relname, reader);
    END IF;

    CONTINUE WHEN t.relname = ANY (hidden_tables);

    IF hidden = 0 THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', t.relname, reader);
    ELSE
      SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
        INTO readable
      FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname !~* hidden_columns;
      IF readable IS NOT NULL THEN
        EXECUTE format('GRANT SELECT (%s) ON public.%I TO %I', readable, t.relname, reader);
      END IF;
    END IF;
  END LOOP;
END
$$;
