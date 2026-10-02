-- Preserve the seat ordering supplied at show creation (for stable seat maps).
ALTER TABLE seats ADD COLUMN pos integer NOT NULL DEFAULT 0;
