CREATE TABLE shows (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  price_paise    bigint      NOT NULL CHECK (price_paise >= 0),
  per_user_limit integer     NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  total_seats    integer     NOT NULL CHECK (total_seats > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id           uuid PRIMARY KEY,
  show_id      uuid        NOT NULL REFERENCES shows(id),
  user_id      text        NOT NULL,
  seats        text[]      NOT NULL,
  amount_paise bigint      NOT NULL CHECK (amount_paise >= 0),
  status       text        NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX reservations_user_idx ON reservations (user_id, show_id);

CREATE TABLE seats (
  show_id        uuid NOT NULL REFERENCES shows(id),
  label          text NOT NULL,
  status         text NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available', 'held', 'confirmed')),
  reservation_id uuid REFERENCES reservations(id),
  user_id        text,
  PRIMARY KEY (show_id, label),
  -- a seat has an owner if and only if it is not available
  CONSTRAINT seats_owner_consistent CHECK (
    (status = 'available' AND reservation_id IS NULL AND user_id IS NULL)
    OR (status <> 'available' AND reservation_id IS NOT NULL AND user_id IS NOT NULL)
  )
);
CREATE INDEX seats_reservation_idx ON seats (reservation_id) WHERE reservation_id IS NOT NULL;

CREATE TABLE user_show_holdings (
  show_id    uuid    NOT NULL REFERENCES shows(id),
  user_id    text    NOT NULL,
  held_count integer NOT NULL CHECK (held_count >= 0),
  PRIMARY KEY (show_id, user_id)
);

CREATE TABLE idempotency_keys (
  user_id        text        NOT NULL,
  key            text        NOT NULL,
  show_id        uuid        NOT NULL,
  request_hash   text        NOT NULL,
  reservation_id uuid        REFERENCES reservations(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
