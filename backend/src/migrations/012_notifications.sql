-- In-app notification inbox — the bell in the top bar.
--
-- Every channel RollDesk had was somewhere else: a webhook post lands in a Teams
-- channel, an e-mail in a mailbox, a browser push on the screen for a few seconds
-- and then nowhere. So "what happened while I was away" had no answer inside the
-- application, and a push dismissed by accident was a notification that never
-- existed. This table is the record: the bell keeps the event, the push only
-- interrupts about it.
--
-- One row per recipient rather than one row per event with a recipient list.
-- „Read" is a property of a person and not of an event, and the unread count — the
-- thing polled every half minute by every open tab — becomes an indexed count on
-- one column instead of a scan that unpacks an array.
CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The event key from the catalogue (created, failure, packageReady, …). Stored
  -- rather than a rendered label: the card is drawn in the reader's own language,
  -- while `subject`/`body` were composed in the instance's notification language.
  event         TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  -- What the notification is about, so the card can open the record instead of
  -- leaving the reader to search a list for an id they just read.
  project_key   TEXT,
  deployment_id TEXT,
  package_id    TEXT,
  -- Who caused it. The actor is never a recipient of their own event (the same
  -- rule as the push routing), but the name still belongs on the card.
  actor_email   TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The drawer reads one person's newest notifications; nothing ever reads the
-- table globally except the retention sweep below.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);

-- The badge. A partial index so the count stays proportional to what is unread
-- rather than to everything the account has ever been told.
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Retention: the inbox is a recent-history view, not an audit trail (that is what
-- the audit log is for), and rows are deleted by age — see pruneOld() in
-- backend/src/inbox.js.
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at);
