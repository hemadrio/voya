-- Destructive fixture: RENAME COLUMN
-- Renaming email_address to email on users table.
-- Old code reading users.email_address will break after this migration;
-- the expand phase must have added the new column first.

ALTER TABLE users RENAME COLUMN email_address TO email;
