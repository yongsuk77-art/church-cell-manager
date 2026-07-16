CREATE TABLE IF NOT EXISTS managed_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_managed_groups_sort_order
  ON managed_groups(sort_order, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_groups_name_unique_nocase
  ON managed_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS managed_group_members (
  group_id TEXT NOT NULL REFERENCES managed_groups(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_managed_group_members_member_id
  ON managed_group_members(member_id);
