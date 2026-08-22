CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM (
    'draft','planning','planned','queued','generating','validating','assembling',
    'completed','paused','failed','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE job_state AS ENUM (
    'planned','queued','generating','validating','retrying','completed','paused','failed','cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspaces (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Local Studio')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS provider_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','openai')),
  encrypted_value jsonb NOT NULL,
  key_hint text NOT NULL,
  status text NOT NULL DEFAULT 'untested',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  prompt text NOT NULL,
  duration_seconds integer NOT NULL CHECK (duration_seconds BETWEEN 1 AND 3600),
  model_id text NOT NULL,
  resolution text NOT NULL,
  aspect_ratio text NOT NULL,
  mode text NOT NULL DEFAULT 'quick' CHECK (mode IN ('quick','advanced')),
  render_tier text NOT NULL DEFAULT 'draft' CHECK (render_tier IN ('draft','final')),
  status project_status NOT NULL DEFAULT 'draft',
  progress numeric(5,2) NOT NULL DEFAULT 0,
  maximum_budget_usd numeric(12,2) NOT NULL DEFAULT 20,
  estimated_cost_usd numeric(12,2) NOT NULL DEFAULT 0,
  spent_usd numeric(12,2) NOT NULL DEFAULT 0,
  reserved_usd numeric(12,2) NOT NULL DEFAULT 0,
  completed_shots integer NOT NULL DEFAULT 0,
  total_shots integer NOT NULL DEFAULT 0,
  current_plan_version integer NOT NULL DEFAULT 0,
  poster_storage_key text,
  final_movie_storage_key text,
  preview_storage_key text,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movie_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content_hash text NOT NULL,
  plan jsonb NOT NULL,
  source_conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  UNIQUE (project_id, content_hash)
);

CREATE TABLE IF NOT EXISTS characters (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  bible jsonb NOT NULL,
  current_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  locks jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  bible jsonb NOT NULL,
  current_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  locks jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS acts (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  purpose text NOT NULL,
  sort_order integer NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS sequences (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  act_id text NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  sort_order integer NOT NULL,
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS scenes (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  act_id text NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
  sequence_id text NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  duration_seconds numeric(8,3) NOT NULL,
  scene_state jsonb NOT NULL,
  continuity_state jsonb NOT NULL,
  current_version integer NOT NULL DEFAULT 1,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE IF NOT EXISTS shots (
  id text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id text NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  duration_seconds numeric(8,3) NOT NULL,
  state job_state NOT NULL DEFAULT 'planned',
  dependencies text[] NOT NULL DEFAULT '{}',
  generation_spec jsonb NOT NULL,
  audio_context jsonb NOT NULL,
  continuity_state jsonb NOT NULL,
  content_hash text NOT NULL,
  current_version integer NOT NULL DEFAULT 0,
  last_operation jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scene_id, sequence)
);

CREATE TABLE IF NOT EXISTS scene_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id text NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version integer NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  affected_region jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scene_id, version)
);

CREATE TABLE IF NOT EXISTS shot_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id text NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  version integer NOT NULL,
  reason text NOT NULL,
  generation_spec jsonb NOT NULL,
  content_hash text NOT NULL,
  provider_operation_id text,
  continuity_score numeric(5,2),
  qc_report jsonb,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shot_id, version),
  UNIQUE (shot_id, content_hash)
);

CREATE TABLE IF NOT EXISTS generation_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id text REFERENCES scenes(id) ON DELETE SET NULL,
  shot_id text REFERENCES shots(id) ON DELETE SET NULL,
  shot_version_id uuid REFERENCES shot_versions(id) ON DELETE SET NULL,
  kind text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint,
  duration_seconds numeric(8,3),
  width integer,
  height integer,
  frame_rate numeric(8,3),
  sample_rate integer,
  checksum text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_key),
  UNIQUE (project_id, checksum, kind)
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id text REFERENCES scenes(id) ON DELETE CASCADE,
  shot_id text REFERENCES shots(id) ON DELETE CASCADE,
  type text NOT NULL,
  state job_state NOT NULL DEFAULT 'planned',
  idempotency_key text NOT NULL UNIQUE,
  priority integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  reserved_cost_usd numeric(12,2) NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  result jsonb,
  last_error jsonb,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  event_type text NOT NULL,
  completed_shot_ids text[] NOT NULL DEFAULT '{}',
  failed_shot_ids text[] NOT NULL DEFAULT '{}',
  pending_shot_ids text[] NOT NULL DEFAULT '{}',
  current_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, sequence)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'AI Screenwriter',
  mode text NOT NULL DEFAULT 'screenwriter' CHECK (mode IN ('screenwriter','director')),
  openai_conversation_id text,
  last_response_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  status text NOT NULL DEFAULT 'completed',
  content jsonb NOT NULL,
  response_id text,
  usage jsonb,
  edited_from_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timeline_clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id text REFERENCES scenes(id) ON DELETE CASCADE,
  shot_id text REFERENCES shots(id) ON DELETE CASCADE,
  track text NOT NULL CHECK (track IN ('video','dialogue','music','sfx','ambience','subtitles')),
  start_seconds numeric(12,3) NOT NULL,
  duration_seconds numeric(12,3) NOT NULL,
  asset_id uuid REFERENCES generation_assets(id) ON DELETE SET NULL,
  source_version integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format text NOT NULL CHECK (format IN ('mp4','mov','srt','screenplay','archive')),
  state job_state NOT NULL DEFAULT 'planned',
  storage_key text,
  qc_report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace_updated ON projects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shots_project_state ON shots(project_id, state);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(state, available_at, priority DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project_sequence ON checkpoints(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assets_project_shot ON generation_assets(project_id, shot_id);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS reserved_usd numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reserved_cost_usd numeric(12,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces','workspace_settings','provider_secrets','projects','characters','locations','scenes','shots',
    'jobs','conversations','timeline_clips'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_%I ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER touch_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', table_name, table_name);
  END LOOP;
END $$;
