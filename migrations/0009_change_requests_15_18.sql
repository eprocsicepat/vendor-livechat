PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES
  ('cat_it', 'Teknologi Informasi', 1, 1, 0, 0),
  ('cat_services', 'Jasa Umum', 1, 2, 0, 0),
  ('cat_construction', 'Konstruksi & Interior', 1, 3, 0, 0),
  ('cat_vehicle', 'Kendaraan & Logistik', 1, 4, 0, 0),
  ('cat_facility', 'Peralatan & Fasilitas', 1, 5, 0, 0),
  ('cat_other', 'Lainnya', 1, 6, 0, 0);
CREATE INDEX IF NOT EXISTS idx_categories_order ON categories(is_active, sort_order, name);

CREATE TABLE IF NOT EXISTS support_agents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'busy', 'offline')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_agents_status ON support_agents(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_conversations (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER,
  first_agent_reply_at INTEGER,
  closed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_one_open_per_vendor ON support_conversations(vendor_id) WHERE status IN ('waiting', 'active');
CREATE INDEX IF NOT EXISTS idx_support_queue ON support_conversations(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_assigned ON support_conversations(assigned_to, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('vendor', 'procurement')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_conversation ON support_messages(conversation_id, created_at);
