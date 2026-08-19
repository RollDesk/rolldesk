-- Browser push notifications.
--
-- Until now a notification left RollDesk only as a webhook post or an e-mail, and
-- both are read where the recipient happens to be looking. The two moments that
-- actually start work — a package handed over for scheduling, and a schedule ready
-- for the person who will install it — were learnt by opening the app and looking.
--
-- A push subscription is per *browser*, not per user: the same person has one at
-- the office and another on a laptop, and each is a separate endpoint with its own
-- keys. Hence a row per subscription with the user as a foreign key, rather than a
-- column on `users`.
--
-- The endpoint URL is the identity of a subscription (that is what the push
-- service addresses), so it carries the unique constraint. A browser that
-- re-subscribes with the same endpoint updates its keys instead of accumulating
-- duplicates — see routes/push.js.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  -- The subscription's public key and auth secret, exactly as the browser hands
  -- them over (base64url). They are not secrets of ours: without them the push
  -- service cannot be addressed at all, and they are useless without the VAPID
  -- private key that stays in the environment.
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  -- Which browser this is, so a user can tell their devices apart when revoking
  -- one. Truncated by the route; never parsed.
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last successful delivery. A subscription that has not been reachable for a
  -- long time is a browser nobody uses any more.
  last_sent_at TIMESTAMPTZ,
  -- Consecutive delivery failures. A push service answering 404/410 means the
  -- subscription is gone and the row is deleted outright; this counts the softer
  -- failures (timeouts, 5xx) so a permanently broken row can be spotted.
  failures    INTEGER NOT NULL DEFAULT 0
);

-- Every send starts from "which subscriptions does this user have".
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Which events a user wants pushed, as {eventKey: boolean}. An absent key means
-- "the default for my role" (see pushTargets.js) rather than "off", so a user who
-- never opened the settings still gets the events their role is expected to act
-- on — and an event added to the catalogue later reaches them too. That is the
-- same rule the per-client webhook event map follows, and for the same reason: a
-- missing key read as "off" is how a whole category of notification went quietly
-- undelivered before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
