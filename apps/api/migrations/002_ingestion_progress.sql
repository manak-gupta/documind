-- 002: ingestion progress for the UI, and instant worker wake-up.

-- What the worker is doing right now, shown live in the library ("embedding 40%").
ALTER TABLE documents
  ADD COLUMN stage    text,
  ADD COLUMN progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100);

-- Any new job sends a NOTIFY on channel "jobs". Workers LISTEN on it, so they pick up a
-- new upload immediately instead of waiting for their next poll. Polling stays as the
-- fallback (NOTIFY is lost if no worker is connected at that moment).
CREATE FUNCTION notify_new_job() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_insert
  AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION notify_new_job();
