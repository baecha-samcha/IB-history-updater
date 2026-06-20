CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_active_idx
  ON app_users (lower(username)) WHERE is_deleted = false;

INSERT INTO app_users (id, username, password_hash, password_salt)
VALUES ('00000000-0000-0000-0000-000000000001', '__shared_workspace__', 'system', 'system')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_state (
  id text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_state (id) VALUES ('shared') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS color_tags (
  id text NOT NULL, user_id uuid NOT NULL REFERENCES app_users(id),
  name text NOT NULL DEFAULT '', color text NOT NULL DEFAULT '#94a3b8',
  is_deleted boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS periods (
  id text NOT NULL, user_id uuid NOT NULL REFERENCES app_users(id), title text NOT NULL DEFAULT '',
  start_date date, end_date date, figures text, source text, photo text,
  color_tag_ids text[] NOT NULL DEFAULT '{}', is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  id text NOT NULL, user_id uuid NOT NULL REFERENCES app_users(id), title text NOT NULL DEFAULT '',
  event_date date, description text, figures text, source text, photo text,
  color_tag_ids text[] NOT NULL DEFAULT '{}', is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS flows (
  id text NOT NULL, user_id uuid NOT NULL REFERENCES app_users(id), title text NOT NULL DEFAULT '',
  description text, color_tag_ids text[] NOT NULL DEFAULT '{}', is_deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS flow_items (
  user_id uuid NOT NULL REFERENCES app_users(id), flow_id text NOT NULL, position integer NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('event', 'period')), item_id text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, flow_id, position),
  FOREIGN KEY (user_id, flow_id) REFERENCES flows(user_id, id)
);

CREATE INDEX IF NOT EXISTS color_tags_user_active_idx ON color_tags(user_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS periods_user_active_idx ON periods(user_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS events_user_active_idx ON events(user_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS flows_user_active_idx ON flows(user_id) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS flow_items_user_active_idx ON flow_items(user_id) WHERE is_deleted = false;

INSERT INTO color_tags (id, user_id, name, color, is_deleted, updated_at)
SELECT DISTINCT ON (id) id, '00000000-0000-0000-0000-000000000001', name, color, false, updated_at
FROM color_tags WHERE user_id <> '00000000-0000-0000-0000-000000000001' AND is_deleted = false
ORDER BY id, updated_at DESC ON CONFLICT (user_id, id) DO NOTHING;

INSERT INTO periods (id, user_id, title, start_date, end_date, figures, source, photo, color_tag_ids, is_deleted, updated_at)
SELECT DISTINCT ON (id) id, '00000000-0000-0000-0000-000000000001', title, start_date, end_date, figures, source, photo, color_tag_ids, false, updated_at
FROM periods WHERE user_id <> '00000000-0000-0000-0000-000000000001' AND is_deleted = false
ORDER BY id, updated_at DESC ON CONFLICT (user_id, id) DO NOTHING;

INSERT INTO events (id, user_id, title, event_date, description, figures, source, photo, color_tag_ids, is_deleted, updated_at)
SELECT DISTINCT ON (id) id, '00000000-0000-0000-0000-000000000001', title, event_date, description, figures, source, photo, color_tag_ids, false, updated_at
FROM events WHERE user_id <> '00000000-0000-0000-0000-000000000001' AND is_deleted = false
ORDER BY id, updated_at DESC ON CONFLICT (user_id, id) DO NOTHING;

INSERT INTO flows (id, user_id, title, description, color_tag_ids, is_deleted, updated_at)
SELECT DISTINCT ON (id) id, '00000000-0000-0000-0000-000000000001', title, description, color_tag_ids, false, updated_at
FROM flows WHERE user_id <> '00000000-0000-0000-0000-000000000001' AND is_deleted = false
ORDER BY id, updated_at DESC ON CONFLICT (user_id, id) DO NOTHING;

INSERT INTO flow_items (user_id, flow_id, position, item_type, item_id, is_deleted, updated_at)
SELECT DISTINCT ON (flow_id, position) '00000000-0000-0000-0000-000000000001', flow_id, position, item_type, item_id, false, updated_at
FROM flow_items WHERE user_id <> '00000000-0000-0000-0000-000000000001' AND is_deleted = false
ORDER BY flow_id, position, updated_at DESC ON CONFLICT (user_id, flow_id, position) DO NOTHING;

UPDATE workspace_state SET version = version + 1, updated_at = now() WHERE id = 'shared';
