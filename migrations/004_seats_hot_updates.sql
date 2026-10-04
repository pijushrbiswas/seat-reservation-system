-- Cancel now finds a reservation's seats by primary key (show_id, label = ANY(reservation.seats)), so nothing queries seats by reservation_id any more.
-- Dropping the index lets updates to seats (status, reservation_id, user_id) stay in the same page ("HOT" updates): no index entry to add or
-- remove and less vacuum work on every reserve and cancel.
DROP INDEX IF EXISTS seats_reservation_idx;
-- Leave room in each page for those in-place updates. Applies to pages written from now on (new shows).
ALTER TABLE seats SET (fillfactor = 80);
