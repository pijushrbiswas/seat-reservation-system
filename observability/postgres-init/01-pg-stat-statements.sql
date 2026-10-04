-- Per-statement CPU and time, for finding the queries that cost the most: `make pg-top`.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
