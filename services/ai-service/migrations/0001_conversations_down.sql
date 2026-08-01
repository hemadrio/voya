-- Rollback migration 0001: Drop conversation session store tables (WO-057)
--
-- Drops in reverse FK order: messages first, then conversations.

DROP TABLE IF EXISTS "conversation_messages";
DROP TABLE IF EXISTS "conversations";
