-- ==============================================================================
-- Nodal: Supabase PostgreSQL + pgvector Schema
-- ==============================================================================

-- 1. Enable the pgvector extension for AI code embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Repositories Table
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'zip' | 'github'
  github_url TEXT,
  branch TEXT DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'PENDING', -- 'PENDING' | 'DOWNLOADING' | 'EXTRACTING' | 'SCANNING' | 'PARSING' | 'CHUNKING' | 'EMBEDDING' | 'COMPLETED' | 'FAILED'
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Repository Files Table
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

-- 4. Code Chunks Table with Vector Embeddings (1536 dimensions)
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

-- Optional HNSW Vector Index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding ON code_chunks USING hnsw (embedding vector_cosine_ops);

-- 5. Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]'::jsonb,
  confidence_score REAL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_repo_id ON chat_messages(repository_id, created_at ASC);

-- 6. Code Symbols Table (Phase 2 AST Engine)
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

-- 7. Code Relationships Table (Phase 2 AST Engine)
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

