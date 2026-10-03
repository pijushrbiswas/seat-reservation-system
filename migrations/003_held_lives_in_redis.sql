-- A seat is only ever 'available' or 'confirmed' in Postgres. "Held" lives in Redis (a lock with a TTL),
-- so it can expire on its own without any sweeper or row write.
ALTER TABLE seats DROP CONSTRAINT seats_status_check;
ALTER TABLE seats DROP CONSTRAINT seats_owner_consistent;
ALTER TABLE seats ADD CONSTRAINT seats_status_check CHECK (status IN ('available', 'confirmed'));
ALTER TABLE seats ADD CONSTRAINT seats_owner_consistent CHECK (
  (status = 'available' AND reservation_id IS NULL AND user_id IS NULL)
  OR (status = 'confirmed' AND reservation_id IS NOT NULL AND user_id IS NOT NULL)
);
