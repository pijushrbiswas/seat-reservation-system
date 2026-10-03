/** Inserts a show. $1 name, $2 price in paise, $3 per-user limit, $4 total seats. Returns the new row. */
export const INSERT_SHOW = `
  INSERT INTO shows (name, price_paise, per_user_limit, total_seats)
  VALUES ($1, $2, $3, $4)
  RETURNING id, name, price_paise, per_user_limit, total_seats, created_at`;

/** Inserts one `available` row per seat, keeping the supplied order in `pos`. $1 show id, $2 seat labels. */
export const INSERT_SEATS = `
  INSERT INTO seats (show_id, label, pos)
  SELECT $1, t.label, t.ord FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)`;

/** Loads a show's immutable facts. $1 show id. */
export const SELECT_SHOW_BY_ID = `
  SELECT id, name, price_paise, per_user_limit, total_seats, created_at
    FROM shows
   WHERE id = $1`;

/**
 * Counts seats per status in one snapshot. $1 show id, $2 labels currently held in Redis.
 * Postgres only stores available/confirmed; an available seat that is in the held list is reported as `held`, so each seat is counted exactly once.
 */
export const COUNT_SEATS_BY_STATUS = `
  SELECT CASE WHEN status = 'available' AND label = ANY($2::text[]) THEN 'held' ELSE status END AS status,
         count(*)::int AS n
    FROM seats
   WHERE show_id = $1
   GROUP BY 1`;

/** Lists every seat in display order with its status, using the same held rule as {@link COUNT_SEATS_BY_STATUS}. $1 show id, $2 held labels. */
export const SELECT_SEATS_WITH_STATUS = `
  SELECT label,
         CASE WHEN status = 'available' AND label = ANY($2::text[]) THEN 'held' ELSE status END AS status
    FROM seats
   WHERE show_id = $1
   ORDER BY pos, label`;
