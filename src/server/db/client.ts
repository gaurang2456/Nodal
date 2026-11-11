import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error(
        'DATABASE_URL environment variable is not defined. Please set your Supabase PostgreSQL connection string in .env.local'
      );
    }

    const isSupabaseOrCloud =
      connectionString.includes('supabase.co') ||
      connectionString.includes('pooler.supabase.com') ||
      connectionString.includes('sslmode=require') ||
      process.env.NODE_ENV === 'production';

    pool = new Pool({
      connectionString,
      ssl: isSupabaseOrCloud ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client:', err);
    });
  }
  return pool;
}

/**
 * Execute a query on the pool.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const p = getDbPool();
  return p.query<T>(text, params);
}

/**
 * Acquire a client from the pool with automatic transaction release helper.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const p = getDbPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

let isSchemaInitialized = false;

/**
 * Ensure pgvector extension and all tables are initialized.
 */
export async function ensureDatabaseSchema(): Promise<void> {
  if (isSchemaInitialized) return;

  try {
    const schemaSql = `
      -- Enable pgvector extension
      CREATE EXTENSION IF NOT EXISTS vector;

      -- Repositories table
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        full_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        github_url TEXT,
        branch TEXT DEFAULT 'main',
        user_id UUID,
        status TEXT NOT NULL DEFAULT 'PENDING',
        stage TEXT DEFAULT 'Pending',
        progress INTEGER DEFAULT 0,
        file_count INTEGER DEFAULT 0,
        folder_count INTEGER DEFAULT 0,
        line_count INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,
        primary_language TEXT,
        framework TEXT,
        technologies JSONB DEFAULT '[]'::jsonb,
        summary JSONB,
        stats JSONB,
        error_message TEXT,
        last_opened_at TIMESTAMPTZ,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      -- Add user_id column if table was created in earlier phase
      ALTER TABLE repositories ADD COLUMN IF NOT EXISTS user_id UUID;
      CREATE INDEX IF NOT EXISTS idx_repositories_user_id ON repositories(user_id);

      -- Add last_opened_at column if table was created before dashboard recency tracking
      ALTER TABLE repositories ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

      -- Repository Files table
      CREATE TABLE IF NOT EXISTS repository_files (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        extension TEXT NOT NULL,
        language TEXT NOT NULL,
        line_count INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_repo_files_repo_id ON repository_files(repository_id);
      CREATE INDEX IF NOT EXISTS idx_repo_files_path ON repository_files(repository_id, file_path);

      -- Code Chunks table with vector embeddings (1536 dimensions)
      CREATE TABLE IF NOT EXISTS code_chunks (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES repository_files(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding vector(1536),
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        language TEXT NOT NULL,
        symbol_name TEXT,
        symbol_type TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_code_chunks_repo_id ON code_chunks(repository_id);

      -- Chat Messages table
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        citations JSONB DEFAULT '[]'::jsonb,
        confidence_score REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_chat_messages_repo_id ON chat_messages(repository_id, created_at ASC);

      -- Code Symbols table (Phase 2 AST Engine)
      CREATE TABLE IF NOT EXISTS code_symbols (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_code_symbols_repo_id ON code_symbols(repository_id);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(repository_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(repository_id, name);

      -- Code Relationships table (Phase 2 AST Engine)
      CREATE TABLE IF NOT EXISTS code_relationships (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        source_symbol_id TEXT NOT NULL,
        target_symbol_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'high',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_code_relationships_repo ON code_relationships(repository_id);
      CREATE INDEX IF NOT EXISTS idx_code_relationships_source ON code_relationships(repository_id, source_symbol_id);
      CREATE INDEX IF NOT EXISTS idx_code_relationships_target ON code_relationships(repository_id, target_symbol_id);

      -- Feature Plans table (AI Feature Planner)
      CREATE TABLE IF NOT EXISTS feature_plans (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        user_id UUID,
        feature_request TEXT NOT NULL,
        plan_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_feature_plans_repo_id ON feature_plans(repository_id);
      CREATE INDEX IF NOT EXISTS idx_feature_plans_user_id ON feature_plans(user_id);

      -- Generated Changesets table (Phase 3 Code Change Generation)
      CREATE TABLE IF NOT EXISTS generated_changesets (
        id TEXT PRIMARY KEY,
        feature_plan_id TEXT NOT NULL REFERENCES feature_plans(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        user_id UUID,
        version INTEGER NOT NULL DEFAULT 1,
        parent_changeset_id TEXT REFERENCES generated_changesets(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        summary TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_changesets_plan_id ON generated_changesets(feature_plan_id);
      CREATE INDEX IF NOT EXISTS idx_changesets_repo_id ON generated_changesets(repository_id);
      CREATE INDEX IF NOT EXISTS idx_changesets_user_id ON generated_changesets(user_id);
      CREATE INDEX IF NOT EXISTS idx_changesets_version ON generated_changesets(feature_plan_id, version DESC);

      -- Generated File Changes table
      CREATE TABLE IF NOT EXISTS generated_file_changes (
        id TEXT PRIMARY KEY,
        changeset_id TEXT NOT NULL REFERENCES generated_changesets(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        change_type TEXT NOT NULL,
        reason TEXT NOT NULL,
        original_content TEXT,
        proposed_content TEXT NOT NULL,
        affected_symbols JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_file_changes_changeset_id ON generated_file_changes(changeset_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_path ON generated_file_changes(changeset_id, file_path);

      -- Changeset Validations table (Phase 3 Code Validation & Testing)
      CREATE TABLE IF NOT EXISTS changeset_validations (
        id TEXT PRIMARY KEY,
        changeset_id TEXT NOT NULL REFERENCES generated_changesets(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        user_id UUID,
        status TEXT NOT NULL DEFAULT 'pending',
        result JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE
      );

      CREATE INDEX IF NOT EXISTS idx_validations_changeset_id ON changeset_validations(changeset_id);
      CREATE INDEX IF NOT EXISTS idx_validations_repo_id ON changeset_validations(repository_id);
      CREATE INDEX IF NOT EXISTS idx_validations_user_id ON changeset_validations(user_id);

      -- GitHub Account Connections table (Phase 4.0 GitHub Integration)
      CREATE TABLE IF NOT EXISTS github_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE,
        github_user_id TEXT NOT NULL,
        github_login TEXT NOT NULL,
        access_token TEXT NOT NULL,
        avatar_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_github_connections_user_id ON github_connections(user_id);

      -- Changeset Branches table (Phase 4.1 & 4.2 GitHub Branch & Commit Staging)
      CREATE TABLE IF NOT EXISTS changeset_branches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        changeset_id TEXT NOT NULL REFERENCES generated_changesets(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        user_id UUID,
        github_repo_owner TEXT NOT NULL,
        github_repo_name TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        staged_tree_sha TEXT,
        commit_sha TEXT,
        commit_message TEXT,
        committed_at TIMESTAMP WITH TIME ZONE,
        status TEXT NOT NULL DEFAULT 'staged',
        file_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(changeset_id, branch_name)
      );

      CREATE INDEX IF NOT EXISTS idx_changeset_branches_changeset_id ON changeset_branches(changeset_id);
      CREATE INDEX IF NOT EXISTS idx_changeset_branches_repo_id ON changeset_branches(repository_id);
      CREATE INDEX IF NOT EXISTS idx_changeset_branches_user_id ON changeset_branches(user_id);

      -- Migration: add columns if table already existed from Phase 4.1
      ALTER TABLE changeset_branches ADD COLUMN IF NOT EXISTS commit_sha TEXT;
      ALTER TABLE changeset_branches ADD COLUMN IF NOT EXISTS commit_message TEXT;
      ALTER TABLE changeset_branches ADD COLUMN IF NOT EXISTS committed_at TIMESTAMP WITH TIME ZONE;

      CREATE INDEX IF NOT EXISTS idx_changeset_branches_commit_sha ON changeset_branches(commit_sha);

      -- Pull Requests table (Phase 4.3 GitHub Pull Request Creation & Status Tracking)
      CREATE TABLE IF NOT EXISTS pull_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        changeset_id TEXT NOT NULL REFERENCES generated_changesets(id) ON DELETE CASCADE,
        repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
        user_id UUID,
        github_repo_owner TEXT NOT NULL,
        github_repo_name TEXT NOT NULL,
        github_pr_number INTEGER NOT NULL,
        github_pr_url TEXT NOT NULL,
        github_pr_api_url TEXT,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(changeset_id)
      );

      CREATE INDEX IF NOT EXISTS idx_pull_requests_changeset_id ON pull_requests(changeset_id);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_id ON pull_requests(repository_id);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_user_id ON pull_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_pull_requests_pr_number ON pull_requests(github_repo_owner, github_repo_name, github_pr_number);
    `;

    await query(schemaSql);
    isSchemaInitialized = true;
    console.log('✅ Supabase PostgreSQL + pgvector schema verified and ready.');
  } catch (err) {
    console.error('⚠️ Could not initialize database schema automatically:', err);
    throw err;
  }
}
