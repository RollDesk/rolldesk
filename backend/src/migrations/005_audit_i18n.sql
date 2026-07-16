-- Localizable audit details.
--
-- The change history used to store a fully rendered English sentence in
-- `detail`. To let the UI show the history in the user's language, new entries
-- also carry a translation key (`detail_key`) and its parameters
-- (`detail_params`), which the frontend renders at display time. The plain
-- `detail` text is kept as a fallback (older entries, search, non-UI consumers).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detail_key    TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detail_params JSONB;
