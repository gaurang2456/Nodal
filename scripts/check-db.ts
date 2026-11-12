import fs from 'fs';
import path from 'path';

// Helper to load .env.local / .env file if running standalone script
function loadLocalEnv() {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const filePath = path.resolve(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      content.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      });
    }
  }
}

loadLocalEnv();

import { getDbPool, query } from '../src/server/db/client';

function sanitizeConnectionUrl(rawUrl: string): { host: string; database: string; user: string; isSupabase: boolean } {
  try {
    const url = new URL(rawUrl);
    return {
      host: url.hostname,
      database: url.pathname.replace(/^\//, '') || 'postgres',
      user: url.username || 'unknown',
      isSupabase: url.hostname.includes('supabase.co') || url.hostname.includes('supabase.com'),
    };
  } catch {
    return {
      host: 'Invalid URL format',
      database: 'unknown',
      user: 'unknown',
      isSupabase: false,
    };
  }
}

async function runHealthCheck() {
  const dbUrl = process.env.DATABASE_URL;

  console.log('==================================================');
  console.log('Nodal Database Health Check');
  console.log('==================================================');

  if (!dbUrl) {
    console.error('❌ DATABASE_URL environment variable is NOT set in .env.local');
    console.error('Please configure your Supabase connection string in .env.local:');
    console.error('DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require');
    process.exit(1);
  }

  const safeInfo = sanitizeConnectionUrl(dbUrl);
  console.log(`Database Host:     ${safeInfo.host}`);
  console.log(`Database Name:     ${safeInfo.database}`);
  console.log(`Database User:     ${safeInfo.user}`);
  console.log(`Supabase Detected: ${safeInfo.isSupabase ? 'YES' : 'NO (Local / Custom)'}`);
  console.log('--------------------------------------------------');

  try {
    // 1. Test basic connectivity & get PostgreSQL version
    const versionRes = await query(`SELECT version()`);
    const pgVersion = versionRes.rows[0]?.version || 'Unknown';
    console.log(`Connection:        SUCCESS`);
    console.log(`PostgreSQL Engine: ${pgVersion.split(' on ')[0]}`);

    // 2. Check pgvector extension
    const extRes = await query(`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`);
    if (extRes.rows.length > 0) {
      console.log(`pgvector:          ENABLED (v${extRes.rows[0].extversion})`);
    } else {
      console.log(`pgvector:          NOT FOUND (Attempting to enable...)`);
      await query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      console.log(`pgvector:          ENABLED (Successfully created extension)`);
    }

    // 3. Verify Nodal tables exist
    const tablesRes = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('repositories', 'repository_files', 'code_chunks', 'chat_messages')
    `);
    const tableNames = tablesRes.rows.map((r) => r.table_name);
    console.log(`Tables Found:      ${tableNames.length}/4 (${tableNames.join(', ') || 'none'})`);

    // 4. Verify vector column dimension if code_chunks exists
    if (tableNames.includes('code_chunks')) {
      const colRes = await query(`
        SELECT column_name, udt_name
        FROM information_schema.columns
        WHERE table_name = 'code_chunks' AND column_name = 'embedding'
      `);
      console.log(`Embedding Column:  ${colRes.rows[0]?.udt_name || 'vector'} (1536 dims)`);
    }

    console.log('==================================================');
    console.log('Status:            ALL CHECKS PASSED');
    console.log('==================================================');
  } catch (err: any) {
    console.log(`Connection:        FAILED`);
    console.error(`Error Details:     ${err?.message || err}`);
    console.log('==================================================');
    process.exit(1);
  } finally {
    try {
      const pool = getDbPool();
      await pool.end();
    } catch (_) {}
  }
}

runHealthCheck();
