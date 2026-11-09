-- 004: keep the retrieval trace with each answer, so "Why this answer?" works for the
-- whole conversation history, not just answers produced in the current browser session.
ALTER TABLE messages ADD COLUMN trace jsonb;
