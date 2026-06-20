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
