CREATE TABLE IF NOT EXISTS app_users (
  id char(36) PRIMARY KEY DEFAULT (uuid()),
  username varchar(50) NOT NULL,
  password_hash varchar(128) NOT NULL,
  password_salt varchar(64) NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  active_username varchar(50) AS (CASE WHEN is_deleted = false THEN lower(username) ELSE NULL END) PERSISTENT,
  created_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  UNIQUE KEY app_users_username_active_idx (active_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO app_users (id, username, password_hash, password_salt)
VALUES ('00000000-0000-0000-0000-000000000001', '__shared_workspace__', 'system', 'system');

CREATE TABLE IF NOT EXISTS workspace_state (
  id varchar(50) PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO workspace_state (id) VALUES ('shared');

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id char(36) NOT NULL,
  expires_at timestamp(6) NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  KEY user_sessions_user_idx (user_id),
  CONSTRAINT user_sessions_user_fk FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS color_tags (
  id varchar(191) NOT NULL,
  user_id char(36) NOT NULL,
  name text NOT NULL,
  color varchar(32) NOT NULL DEFAULT '#94a3b8',
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, id),
  KEY color_tags_user_active_idx (user_id, is_deleted),
  CONSTRAINT color_tags_user_fk FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS periods (
  id varchar(191) NOT NULL,
  user_id char(36) NOT NULL,
  title text NOT NULL,
  start_date date,
  end_date date,
  description text,
  category text,
  figures text,
  source text,
  photo longtext,
  color_tag_ids json NOT NULL DEFAULT ('[]'),
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, id),
  KEY periods_user_active_idx (user_id, is_deleted),
  CONSTRAINT periods_user_fk FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
  id varchar(191) NOT NULL,
  user_id char(36) NOT NULL,
  title text NOT NULL,
  event_date date,
  description text,
  category text,
  figures text,
  source text,
  photo longtext,
  color_tag_ids json NOT NULL DEFAULT ('[]'),
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, id),
  KEY events_user_active_idx (user_id, is_deleted),
  CONSTRAINT events_user_fk FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flows (
  id varchar(191) NOT NULL,
  user_id char(36) NOT NULL,
  title text NOT NULL,
  description text,
  color_tag_ids json NOT NULL DEFAULT ('[]'),
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, id),
  KEY flows_user_active_idx (user_id, is_deleted),
  CONSTRAINT flows_user_fk FOREIGN KEY (user_id) REFERENCES app_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_items (
  user_id char(36) NOT NULL,
  flow_id varchar(191) NOT NULL,
  position integer NOT NULL,
  item_type enum('event', 'period') NOT NULL,
  item_id varchar(191) NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamp(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (user_id, flow_id, position),
  KEY flow_items_user_active_idx (user_id, is_deleted),
  CONSTRAINT flow_items_flow_fk FOREIGN KEY (user_id, flow_id) REFERENCES flows(user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
