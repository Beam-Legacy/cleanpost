-- Local and CI only. Production roles are created by infrastructure code.
-- cleanpost      owner of every table; used by migrations and the system role (bypasses RLS as a superuser here)
-- cleanpost_app  group role that holds table grants; never BYPASSRLS
-- cleanpost_web  login used by the web app and worker; member of cleanpost_app
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cleanpost_app') THEN
    CREATE ROLE cleanpost_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cleanpost_web') THEN
    CREATE ROLE cleanpost_web LOGIN PASSWORD 'cleanpost_web' NOBYPASSRLS IN ROLE cleanpost_app;
  END IF;
END
$$;

CREATE DATABASE cleanpost_test OWNER cleanpost;
