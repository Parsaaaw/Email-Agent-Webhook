CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  attachments TEXT,
  agent_summary TEXT,
  read_at TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS emails_received_at_idx ON emails (received_at DESC);
