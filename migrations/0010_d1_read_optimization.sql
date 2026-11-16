-- Reduce D1 rows read by indexing the most common visible-message filters.
CREATE INDEX IF NOT EXISTS idx_messages_topic_visible_recent
  ON messages(topic_id, created_at DESC, id DESC)
  WHERE visibility = 'visible';

CREATE INDEX IF NOT EXISTS idx_messages_project_visible_recent
  ON messages(project_id, created_at DESC)
  WHERE visibility = 'visible';

-- Keep support inbox/history summaries on the conversation row instead of
-- running COUNT(*) across every message on each refresh.
ALTER TABLE support_conversations
  ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE support_conversations
  ADD COLUMN last_message_body TEXT;

UPDATE support_conversations
SET
  message_count = (
    SELECT COUNT(*)
    FROM support_messages m
    WHERE m.conversation_id = support_conversations.id
  ),
  last_message_body = (
    SELECT m.body
    FROM support_messages m
    WHERE m.conversation_id = support_conversations.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  );

CREATE INDEX IF NOT EXISTS idx_support_conversations_vendor_activity
  ON support_conversations(vendor_id, COALESCE(last_message_at, created_at) DESC);

-- The rate-limit lookup uses (ip, kind, created_at); cleanup by created_at
-- also needs a leading-column index to avoid scanning the full attempts table.
CREATE INDEX IF NOT EXISTS idx_auth_attempts_created
  ON auth_attempts(created_at);
