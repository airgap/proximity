-- Apply through the ordinary migration workflow before starting the updated worker.
-- Payload is text so retries preserve the exact signed bytes.
CREATE TABLE IF NOT EXISTS note_deliveries (
  egress_id text PRIMARY KEY REFERENCES recordings (egress_id),
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  last_error text,
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS note_deliveries_due_idx
  ON note_deliveries (next_attempt_at) WHERE status = 'pending';
