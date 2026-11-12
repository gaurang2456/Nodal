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

async function cleanupTestRepos() {
  console.log('==================================================');
  console.log('Nodal Database Cleanup - Test & Orphan Repositories');
  console.log('==================================================');

  try {
    // 1. Find repositories with user_id IS NULL or starting with test-
    const findRes = await query(
      `SELECT id, name, user_id, created_at FROM repositories WHERE user_id IS NULL OR id LIKE 'test-%' ORDER BY created_at DESC`
    );

    console.log(`Found ${findRes.rows.length} test/orphaned repositories to clean up:`);
    for (const row of findRes.rows) {
      console.log(` - ID: ${row.id} | Name: ${row.name} | user_id: ${row.user_id || 'NULL'}`);
    }

    if (findRes.rows.length === 0) {
      console.log('No test or orphaned repositories found. Database is already clean!');
      return;
    }

    // 2. Delete the repositories (cascades to files, chunks, symbols, feature_plans, etc.)
    const deleteRes = await query(
      `DELETE FROM repositories WHERE user_id IS NULL OR id LIKE 'test-%'`
    );

    console.log(`\n Successfully purged ${deleteRes.rowCount} test/orphaned repositories and cascaded records.`);

    // 3. Verify remaining repositories
    const remaining = await query(
      `SELECT id, name, user_id, created_at FROM repositories ORDER BY created_at DESC`
    );

    console.log(`\nRemaining user repositories (${remaining.rows.length}):`);
    for (const row of remaining.rows) {
      console.log(` - ID: ${row.id} | Name: ${row.name} | user_id: ${row.user_id}`);
    }

  } catch (error) {
    console.error('Cleanup failed with error:', error);
  } finally {
    try {
      await getDbPool().end();
    } catch {}
  }
}

cleanupTestRepos();
