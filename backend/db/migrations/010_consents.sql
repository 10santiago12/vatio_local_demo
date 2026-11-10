-- Proof of account activation. A new document version pair adds a new row.
CREATE TABLE consents (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  timestamp_utc TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  policy_version TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  habeas_data_accepted INTEGER NOT NULL CHECK (habeas_data_accepted = 1),
  terms_accepted INTEGER NOT NULL CHECK (terms_accepted = 1),
  UNIQUE (user_id, policy_version, terms_version)
);
