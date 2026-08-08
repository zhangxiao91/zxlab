ALTER TABLE transfers ADD COLUMN client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_sender_request
  ON transfers(sender_device_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
