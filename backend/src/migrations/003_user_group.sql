-- Optional group/team label on user accounts.
--
-- Purely descriptive: it does not grant any access, it just makes the Users
-- directory easier to manage (e.g. "Deployment team", "PWPW", "Ops"). New
-- installs already get the column from 001_init.sql; this migration adds it to
-- databases created before the column existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_group TEXT;
