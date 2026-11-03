-- Demo history (DEC-19): the state of the 90-day replay that builds the demo's history, next to the
-- clock it moves. {} when no history was ever built; then {"state": "pending" | "running" | "done" |
-- "failed", "days", "day", "requestedAt", "startedAt", "finishedAt"}. Set to pending by
-- `pnpm demo:reset` (system role, local and preview); the worker runs the replay and reports here.
ALTER TABLE app.clock ADD COLUMN IF NOT EXISTS "demo" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
GRANT UPDATE ("demo") ON app.clock TO cleanpost_app;
