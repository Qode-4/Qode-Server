import type { Pool } from "pg";

export const initializeCoreSchema = async (pool: Pool): Promise<void> => {
  // SQL 원본은 MySQL 문법이므로 Postgres 타입/문법으로 변환해 생성합니다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email VARCHAR(100) NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(50) NOT NULL,
      avatar_url TEXT NULL,
      created_at TIMESTAMPTZ NULL,
      token_version INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (email)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_refresh_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      token_hash VARCHAR(128) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      description TEXT NULL,
      git_url TEXT NULL,
      git_auth_type TEXT NOT NULL DEFAULT 'NONE',
      git_access_token_encrypted TEXT NULL,
      invite_code VARCHAR(8) NOT NULL,
      last_synced_at TIMESTAMPTZ NULL,
      question_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by_id UUID NOT NULL
    )
  `);

  await pool.query(`
    ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS git_url TEXT NULL,
    ADD COLUMN IF NOT EXISTS git_auth_type TEXT NOT NULL DEFAULT 'NONE',
    ADD COLUMN IF NOT EXISTS git_access_token_encrypted TEXT NULL,
    ADD COLUMN IF NOT EXISTS invite_code VARCHAR(8),
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS question_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS created_by_id UUID
  `);

  await pool.query(`
    UPDATE projects
    SET
      invite_code = COALESCE(invite_code, UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 8))),
      git_auth_type = COALESCE(git_auth_type, 'NONE'),
      question_count = COALESCE(question_count, 0),
      created_by_id = COALESCE(created_by_id, '00000000-0000-0000-0000-000000000000'::uuid)
    WHERE
      invite_code IS NULL
      OR git_auth_type IS NULL
      OR question_count IS NULL
      OR created_by_id IS NULL
  `);

  await pool.query(`
    ALTER TABLE projects
    DROP COLUMN IF EXISTS created_by_name,
    DROP COLUMN IF EXISTS created_by_avatar_url,
    DROP COLUMN IF EXISTS role
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_members (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      project_id UUID NOT NULL,
      role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MEMBER')),
      joined_at TIMESTAMPTZ NULL
    )
  `);

  // Legacy 데이터 중 부모가 없는 멤버 레코드를 정리한 뒤 FK를 추가합니다.
  await pool.query(`
    DELETE FROM project_members pm
    WHERE NOT EXISTS (
      SELECT 1
      FROM projects p
      WHERE p.id = pm.project_id
    )
  `);

  await pool.query(`
    DELETE FROM project_members pm
    WHERE NOT EXISTS (
      SELECT 1
      FROM users u
      WHERE u.id = pm.user_id
    )
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'project_members_project_id_fkey'
      ) THEN
        ALTER TABLE project_members DROP CONSTRAINT project_members_project_id_fkey;
      END IF;
      ALTER TABLE project_members
      ADD CONSTRAINT project_members_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'project_members_user_id_fkey'
      ) THEN
        ALTER TABLE project_members DROP CONSTRAINT project_members_user_id_fkey;
      END IF;
      ALTER TABLE project_members
      ADD CONSTRAINT project_members_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_sync_jobs (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK (status IN ('queued', 'syncing', 'done', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
      error_code TEXT NULL,
      error_message TEXT NULL,
      synced_commit TEXT NULL,
      error TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ NULL,
      finished_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_project_sync_jobs_project_created_at
    ON project_sync_jobs (project_id, created_at DESC)
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'project_sync_jobs_status_check'
      ) THEN
        ALTER TABLE project_sync_jobs DROP CONSTRAINT project_sync_jobs_status_check;
      END IF;
      ALTER TABLE project_sync_jobs
      ADD CONSTRAINT project_sync_jobs_status_check
      CHECK (status IN ('queued', 'syncing', 'done', 'failed'));
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_oauth_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      github_user_id BIGINT NOT NULL,
      github_login TEXT NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT NULL,
      scope TEXT NOT NULL,
      expires_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, github_user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_oauth_device_flows (
      flow_id UUID PRIMARY KEY,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_code TEXT NOT NULL,
      user_code TEXT NOT NULL,
      verification_uri TEXT NOT NULL,
      verification_uri_complete TEXT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      interval_sec INT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('auth_pending', 'authorized', 'auth_failed', 'expired')),
      token_ref_id UUID NULL REFERENCES github_oauth_tokens(id) ON DELETE SET NULL,
      error TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_github_oauth_device_flows_requested_by
    ON github_oauth_device_flows (requested_by)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_github_oauth_device_flows_status
    ON github_oauth_device_flows (status)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_git_connections (
      id UUID PRIMARY KEY,
      project_id UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider = 'github_oauth'),
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      git_url TEXT NOT NULL,
      token_ref_id UUID NOT NULL REFERENCES github_oauth_tokens(id),
      connected_by UUID NOT NULL REFERENCES users(id),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    DO $$
    BEGIN
      CREATE TYPE chat_type AS ENUM ('PERSONAL', 'TEAM');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_by UUID NOT NULL REFERENCES users(id),
      name VARCHAR(100) NOT NULL,
      chat_type chat_type NOT NULL DEFAULT 'PERSONAL',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE chats
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE chats
    SET created_at = NOW()
    WHERE created_at IS NULL
  `);

  await pool.query(`
    ALTER TABLE chats
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_chats_project_id ON chats(project_id);
  `);

  await pool.query(`
    DO $$
    BEGIN
      CREATE TYPE message_status AS ENUM ('COMPLETE', 'STREAMING', 'FAILED');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    DO $$
    BEGIN
      CREATE TYPE message_role AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
      role message_role NOT NULL DEFAULT 'USER',
      content TEXT NOT NULL DEFAULT '',
      status message_status NOT NULL DEFAULT 'COMPLETE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE messages
    SET created_at = NOW()
    WHERE created_at IS NULL
  `);

  await pool.query(`
    ALTER TABLE messages
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
    ON messages (chat_id, created_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_user_id
    ON messages (user_id)
  `);


  await pool.query(`
    DO $$
    BEGIN
      CREATE TYPE member_role AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_participants (
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_role member_role NOT NULL DEFAULT 'MEMBER',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      left_at TIMESTAMPTZ NULL,
      PRIMARY KEY (chat_id, user_id)
    )
  `);

  await pool.query(`
    ALTER TABLE chat_participants
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
  `);

  await pool.query(`
    UPDATE chat_participants
    SET created_at = NOW()
    WHERE created_at IS NULL
  `);

  await pool.query(`
    ALTER TABLE chat_participants
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id BIGSERIAL PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES messages(id),
      file_path TEXT NOT NULL,
      start_line INT NULL,
      end_line INT NULL,
      snippet TEXT NOT NULL
    )
  `);

  // Legacy 데이터 중 부모 메시지가 없는 소스 레코드를 정리합니다.
  await pool.query(`
    DELETE FROM sources s
    WHERE NOT EXISTS (
      SELECT 1
      FROM messages m
      WHERE m.id = s.message_id
    )
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'sources_message_id_fkey'
      ) THEN
        ALTER TABLE sources DROP CONSTRAINT sources_message_id_fkey;
      END IF;
      ALTER TABLE sources
      ADD CONSTRAINT sources_message_id_fkey
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_analysis (
      id UUID PRIMARY KEY,
      project_id UUID UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
      summary JSONB NULL,
      source_commit TEXT NULL,
      error_message TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sample_items (
      id UUID PRIMARY KEY,
      title VARCHAR(120) NOT NULL,
      description TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS storage_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('github_repo','figma','figjam')),
      title VARCHAR(200) NOT NULL,
      url TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT storage_items_project_url_unique UNIQUE (project_id, url)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS storage_items_project_created_idx
    ON storage_items (project_id, created_at DESC)
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sections (
      id UUID PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT sections_project_name_unique UNIQUE (project_id, name)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sections_project_name_idx
    ON sections (project_id, name)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folders (
      id UUID PRIMARY KEY,
      section_id UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT folders_section_name_unique UNIQUE (section_id, name)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS folders_section_name_idx
    ON folders (section_id, name)
  `);
};
