-- 003: vector search settings for this database.
--
-- HNSW returns its ef_search (default 40) nearest candidates and THEN applies our WHERE filter
-- (user_id, document_id). If most neighbours belong to other users, too few rows survive the
-- filter, and recall silently drops. pgvector 0.8's iterative scan keeps searching the graph
-- until enough rows pass the filter.
--
-- Set at database level (whatever this database is called), so every new connection gets it.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET hnsw.iterative_scan = %L', current_database(), 'relaxed_order');
END
$$;
