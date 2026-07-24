-- Microsoft Teams (Graph) threading.
--
-- When the Graph integration is configured, each deployment's notifications are
-- grouped into a single Teams channel thread: the first event creates a root
-- channel message and later events are posted as replies to it. This table maps
-- a deployment id to the root message id so replies land in the right thread.
CREATE TABLE IF NOT EXISTS teams_threads (
  deployment_id TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
