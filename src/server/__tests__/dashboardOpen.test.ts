import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Load .env.local if not already in process.env
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

import { ensureDatabaseSchema, query, getDbPool } from '../db/client';
import { mapBackendRepoToRepository } from '../../lib/api/queries';

describe('Dashboard & Repository last_opened_at Tests', () => {
  const ownerId = 'c1b2c3d4-0000-0000-0000-cccccccccccc';
  const otherUserId = 'd1b2c3d4-0000-0000-0000-dddddddddddd';

  test('1. POST /api/repositories/[id]/open rejects unauthenticated requests with 401', async () => {
    const { POST } = await import('../../app/api/repositories/[id]/open/route');
    const fakeReq = new Request('http://localhost:3000/api/repositories/repo-1/open', {
      method: 'POST',
    }) as Parameters<typeof POST>[0];
    const res = await POST(fakeReq, { params: Promise.resolve({ id: 'repo-1' }) });
    assert.strictEqual(res.status, 401);
  });

  test('2. GET /api/repositories rejects unauthenticated requests with 401', async () => {
    const { GET } = await import('../../app/api/repositories/route');
    const fakeReq = new Request('http://localhost:3000/api/repositories') as Parameters<typeof GET>[0];
    const res = await GET(fakeReq);
    assert.strictEqual(res.status, 401);
  });

  test('3. mapBackendRepoToRepository maps createdAt and lastOpenedAt cleanly', () => {
    const unopened = mapBackendRepoToRepository({
      id: 'repo-unopened',
      name: 'Unopened',
      full_name: 'user/unopened',
      status: 'COMPLETED',
      created_at: '2026-11-10T10:00:00Z',
    });

    assert.strictEqual(unopened.createdAt, '2026-11-10T10:00:00Z');
    assert.strictEqual(unopened.lastOpenedAt, null);

    const opened = mapBackendRepoToRepository({
      id: 'repo-opened',
      name: 'Opened',
      full_name: 'user/opened',
      status: 'COMPLETED',
      created_at: '2026-11-10T10:00:00Z',
      last_opened_at: '2026-11-11T15:30:00Z',
    });

    assert.strictEqual(opened.createdAt, '2026-11-10T10:00:00Z');
    assert.strictEqual(opened.lastOpenedAt, '2026-11-11T15:30:00Z');
  });

  test('4. Database schema adds nullable last_opened_at and isolates orphaned / foreign repos', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const ts = Date.now();
    const repoOlderOpen = `test-open-1-${ts}`;
    const repoNewerOpen = `test-open-2-${ts}`;
    const repoNeverOpen = `test-open-3-${ts}`;
    const repoOrphan = `test-open-orphan-${ts}`;

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status, last_opened_at, created_at)
       VALUES
         ($1, 'Older Opened', 'owner/older', 'zip', $5, 'COMPLETED', '2026-11-01T10:00:00Z', '2026-11-01T09:00:00Z'),
         ($2, 'Newer Opened', 'owner/newer', 'zip', $5, 'COMPLETED', '2026-11-05T10:00:00Z', '2026-11-01T08:00:00Z'),
         ($3, 'Never Opened', 'owner/never', 'zip', $5, 'COMPLETED', NULL, '2026-11-06T09:00:00Z'),
         ($4, 'Orphaned Repo', 'anon/orphan', 'zip', NULL, 'COMPLETED', NULL, '2026-11-06T10:00:00Z')`,
      [repoOlderOpen, repoNewerOpen, repoNeverOpen, repoOrphan, ownerId]
    );

    // Owner listing excludes NULL user_id rows and orders by last_opened_at DESC NULLS LAST, created_at DESC
    const listRes = await query(
      `SELECT id, user_id, last_opened_at
       FROM repositories
       WHERE user_id = $1 AND id IN ($2, $3, $4, $5)
       ORDER BY last_opened_at DESC NULLS LAST, created_at DESC`,
      [ownerId, repoOlderOpen, repoNewerOpen, repoNeverOpen, repoOrphan]
    );

    assert.deepStrictEqual(
      listRes.rows.map((r: { id: string }) => r.id),
      [repoNewerOpen, repoOlderOpen, repoNeverOpen]
    );
    assert.strictEqual(listRes.rows[2].last_opened_at, null);

    // Defense-in-depth UPDATE guard must not touch orphaned or non-owned repos
    const updateForeign = await query(
      `UPDATE repositories SET last_opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`,
      [repoOrphan, otherUserId]
    );
    assert.strictEqual(updateForeign.rows.length, 0);

    const updateOther = await query(
      `UPDATE repositories SET last_opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`,
      [repoOlderOpen, otherUserId]
    );
    assert.strictEqual(updateOther.rows.length, 0);

    // Owner update persists last_opened_at = NOW()
    const updateOwner = await query(
      `UPDATE repositories SET last_opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id, last_opened_at`,
      [repoNeverOpen, ownerId]
    );
    assert.strictEqual(updateOwner.rows.length, 1);
    assert.ok(updateOwner.rows[0].last_opened_at);

    await query(`DELETE FROM repositories WHERE id IN ($1, $2, $3, $4)`, [
      repoOlderOpen,
      repoNewerOpen,
      repoNeverOpen,
      repoOrphan,
    ]);
  });

  after(async () => {
    try {
      await getDbPool().end();
    } catch {}
  });
});

