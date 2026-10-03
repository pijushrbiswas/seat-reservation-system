/** Ids of the newest shows, which are the ones that get seat gauges. $1 how many to return. */
export const SELECT_RECENT_SHOW_IDS = `
  SELECT id
    FROM shows
   ORDER BY created_at DESC
   LIMIT $1`;

/**
 * Available, held and confirmed counts per show for the gauges. $1 show ids, $2 and $3 are parallel arrays of (show id, label) currently held in Redis.
 * An available seat that appears in the held list counts as held, so each seat is counted once.
 */
export const SELECT_SHOW_STATS = `
  SELECT sh.id AS show_id, sh.total_seats,
         count(*) FILTER (WHERE s.status = 'available' AND h.label IS NULL) AS available,
         count(*) FILTER (WHERE s.status = 'available' AND h.label IS NOT NULL) AS held,
         count(*) FILTER (WHERE s.status = 'confirmed') AS confirmed
    FROM shows sh
    LEFT JOIN seats s ON s.show_id = sh.id
    LEFT JOIN unnest($2::uuid[], $3::text[]) AS h(show_id, label)
           ON h.show_id = s.show_id AND h.label = s.label
   WHERE sh.id = ANY($1::uuid[])
   GROUP BY sh.id, sh.total_seats`;
