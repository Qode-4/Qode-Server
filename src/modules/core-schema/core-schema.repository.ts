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
    ADD COLUMN IF NOT EXISTS invite_code VARCHAR(8),
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS question_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS created_by_id UUID
  `);

  await pool.query(`
    UPDATE projects
    SET
      invite_code = COALESCE(invite_code, UPPER(SUBSTRING(REPLACE(id::text, '-', '') FROM 1 FOR 8))),
      question_count = COALESCE(question_count, 0),
      created_by_id = COALESCE(created_by_id, '00000000-0000-0000-0000-000000000000'::uuid)
    WHERE
      invite_code IS NULL
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
    CREATE TABLE IF NOT EXISTS sources (
      id BIGSERIAL PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES messages(id),
      file_path TEXT NOT NULL,
      start_line INT NULL,
      end_line INT NULL,
      snippet TEXT NOT NULL
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
};
