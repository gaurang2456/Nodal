import { test, describe, after, before } from 'node:test';
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

import { ensureDatabaseSchema, query } from '../db/client';
import { GitHubWriteService } from '../github/githubWriteService';
import { GitHubConnectionService } from '../github/githubConnectionService';
import { GitHubApiClient } from '../github/githubClient';
import { POST as postCommitHandler, GET as getCommitHandler } from '@/app/api/changesets/[changesetId]/github/commit/route';
import { NextRequest } from 'next/server';

describe('Phase 4.2: GitHub Commit and Push to Feature Branch Tests', () => {
  const testUserId = 'f4200000-0000-0000-0000-000000000001';
  const otherUserId = 'f4200000-0000-0000-0000-000000000002';
  const testRepoId = `test-repo-gh-commit-${Date.now()}`;
  const testPlanId = `fp-42-${Date.now()}`;
  const testChangesetId = `cs-42-approved-${Date.now()}`;
  const unapprovedChangesetId = `cs-42-ready-${Date.now()}`;
  const branchName = `nodal/feature-plan-test42-v1`;
  const baseSha = 'base-sha-commit-test-1234567890';

  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureDatabaseSchema();

      // Clean old test records
      await query(`DELETE FROM repositories WHERE id = $1;`, [testRepoId]);

      // 1. Create GitHub-backed repository
      await query(
        `INSERT INTO repositories (
          id, name, full_name, source_type, github_url, user_id, status, branch
        )
        VALUES ($1, 'Test-Commit-Repo', 'testowner/testcommitrepo', 'github', 'https://github.com/testowner/testcommitrepo', $2, 'COMPLETED', 'main')`,
        [testRepoId, testUserId]
      );

      // 2. Connect test GitHub account
      await GitHubConnectionService.connectGitHubAccount({
        userId: testUserId,
        githubUserId: '99902',
        githubLogin: 'test-commit-user',
        accessToken: 'ghp_test_token_phase_4_2_commit_service',
        avatarUrl: 'https://avatars.githubusercontent.com/u/99902?v=4',
      });

      // 3. Create Feature Plan
      await query(
        `INSERT INTO feature_plans (
          id, repository_id, user_id, feature_request, plan_json, status
        )
        VALUES ($1, $2, $3, 'Add audit logging', '{"title":"Audit Logging"}'::jsonb, 'COMPLETED')`,
        [testPlanId, testRepoId, testUserId]
      );

      // 4. Create Approved Changeset
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 1, 'approved', 'Add audit logger service')`,
        [testChangesetId, testPlanId, testRepoId, testUserId]
      );

      // Add file changes to approved changeset
      await query(
        `INSERT INTO generated_file_changes (
          id, changeset_id, file_path, change_type, reason, original_content, proposed_content
        )
        VALUES
          ($1, $2, 'src/services/logger.ts', 'create', 'Create logger service', NULL, 'export class AuditLogger {}'),
          ($3, $2, 'src/app.ts', 'modify', 'Import audit logger', 'export const app = "main";', 'export const app = "main";\nimport "./services/logger";')`,
        [`fc-42-1-${Date.now()}`, testChangesetId, `fc-42-2-${Date.now()}`]
      );

      // 5. Create Unapproved Changeset (status: 'ready')
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 2, 'ready', 'Unapproved changeset')`,
        [unapprovedChangesetId, testPlanId, testRepoId, testUserId]
      );
      await query(
        `INSERT INTO generated_file_changes (
          id, changeset_id, file_path, change_type, reason, original_content, proposed_content
        )
        VALUES ($1, $2, 'src/temp.ts', 'create', 'Temp', NULL, 'export const temp = 1;')`,
        [`fc-42-3-${Date.now()}`, unapprovedChangesetId]
      );

      // 6. Stage feature branch in changeset_branches (as created in Phase 4.1)
      await query(
        `INSERT INTO changeset_branches (
          changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
          branch_name, base_branch, base_sha, staged_tree_sha, status, file_count
        )
        VALUES ($1, $2, $3, 'testowner', 'testcommitrepo', $4, 'main', $5, 'staged-tree-sha-42', 'staged', 2)`,
        [testChangesetId, testRepoId, testUserId, branchName, baseSha]
      );
    }
  });

  after(async () => {
    if (process.env.DATABASE_URL) {
      await query(`DELETE FROM repositories WHERE id = $1;`, [testRepoId]);
      await query(`DELETE FROM github_connections WHERE user_id = $1;`, [testUserId]);
    }
  });

  // Test 1: Rejects unapproved changesets
  test('1. Rejects commit creation on unapproved changesets', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.commitAndPushChangeset(unapprovedChangesetId, testUserId);
      assert.fail('Should have thrown an error for unapproved changeset');
    } catch (err: any) {
      assert.ok(err.message.includes('Changeset must be approved before committing'));
    }
  });

  // Test 2: User Isolation
  test('2. Rejects commit creation if user does not own changeset or repository', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.commitAndPushChangeset(testChangesetId, otherUserId);
      assert.fail('Should have thrown an unauthorized error');
    } catch (err: any) {
      assert.ok(err.message.includes('Unauthorized') || err.message.includes('No GitHub account connected'));
    }
  });

  // Test 3: Validation Blocking
  test('3. Blocks commit creation if changeset validation explicitly failed', async () => {
    if (!process.env.DATABASE_URL) return;

    const valId = `val-failed-${Date.now()}`;
    await query(
      `INSERT INTO changeset_validations (id, changeset_id, repository_id, user_id, status, result)
       VALUES ($1, $2, $3, $4, 'failed', '{"summary":"Build errors"}'::jsonb)`,
      [valId, testChangesetId, testRepoId, testUserId]
    );

    try {
      await GitHubWriteService.commitAndPushChangeset(testChangesetId, testUserId);
      assert.fail('Should have blocked commit creation due to failed validation');
    } catch (err: any) {
      assert.ok(err.message.includes('Validation FAILED for this changeset'));
    }

    await query(`DELETE FROM changeset_validations WHERE id = $1;`, [valId]);
  });

  // Test 4: Missing Branch Protection
  test('4. Aborts commit creation if feature branch has not been created yet', async () => {
    if (!process.env.DATABASE_URL) return;

    // Create a new approved changeset without a branch record
    const unbranchedCsId = `cs-42-nobranch-${Date.now()}`;
    await query(
      `INSERT INTO generated_changesets (id, feature_plan_id, repository_id, user_id, version, status, summary)
       VALUES ($1, $2, $3, $4, 3, 'approved', 'No branch changeset')`,
      [unbranchedCsId, testPlanId, testRepoId, testUserId]
    );
    await query(
      `INSERT INTO generated_file_changes (id, changeset_id, file_path, change_type, reason, proposed_content)
       VALUES ($1, $2, 'src/temp.ts', 'create', 'Temp', 'export const x = 1;')`,
      [`fc-42-nobranch-${Date.now()}`, unbranchedCsId]
    );

    try {
      await GitHubWriteService.commitAndPushChangeset(unbranchedCsId, testUserId);
      assert.fail('Should have thrown an error for missing branch');
    } catch (err: any) {
      assert.ok(err.message.includes('No feature branch has been created'));
    }
  });

  // Test 5: Branch Concurrency Protection (Branch changed unexpectedly)
  test('5. Branch Concurrency: Aborts if GitHub branch head SHA has moved unexpectedly', async () => {
    if (!process.env.DATABASE_URL) return;

    const originalGetRef = GitHubApiClient.prototype.getRef;

    try {
      // Simulate that someone else pushed a commit to the feature branch upstream
      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === `heads/${branchName}`) {
          return {
            ref: `refs/heads/${branchName}`,
            object: { sha: 'unexpected-third-party-commit-sha', type: 'commit' },
          };
        }
        return null;
      };

      await GitHubWriteService.commitAndPushChangeset(testChangesetId, testUserId);
      assert.fail('Should have detected branch concurrency collision and aborted');
    } catch (err: any) {
      assert.ok(err.message.includes('changed unexpectedly since Nodal prepared the changes'));
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
    }
  });

  // Test 6: Drift Re-check Protection
  test('6. Drift Re-check: Aborts if upstream file has been modified before commit', async () => {
    if (!process.env.DATABASE_URL) return;

    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalGetFileContent = GitHubApiClient.prototype.getFileContent;

    try {
      // Branch is intact at baseSha
      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === `heads/${branchName}`) {
          return { ref: `refs/heads/${branchName}`, object: { sha: baseSha, type: 'commit' } };
        }
        return null;
      };

      // File modified upstream
      GitHubApiClient.prototype.getFileContent = async (_owner, _repo, filePath) => {
        if (filePath === 'src/app.ts') {
          return {
            name: 'app.ts',
            path: 'src/app.ts',
            sha: 'file-sha-drifted',
            size: 50,
            content: Buffer.from('export const app = "drifted-upstream";').toString('base64'),
            encoding: 'base64',
          };
        }
        return null;
      };

      await GitHubWriteService.commitAndPushChangeset(testChangesetId, testUserId);
      assert.fail('Should have detected drift and aborted');
    } catch (err: any) {
      assert.ok(err.message.includes('Repository drift detected'));
      assert.ok(err.message.includes('src/app.ts'));
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.getFileContent = originalGetFileContent;
    }
  });

  // Test 7: Successful Commit Creation, Fast-Forward Push, and Persistence
  test('7. Successfully creates atomic commit, advances branch ref, and persists metadata', async () => {
    if (!process.env.DATABASE_URL) return;

    let createdCommitMessage = '';
    let createdCommitTree = '';
    let createdCommitParents: string[] = [];
    let updatedRef = '';
    let updatedSha = '';

    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalGetFileContent = GitHubApiClient.prototype.getFileContent;
    const originalCreateCommit = GitHubApiClient.prototype.createCommit;
    const originalUpdateRef = GitHubApiClient.prototype.updateRef;

    try {
      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === `heads/${branchName}`) {
          return { ref: `refs/heads/${branchName}`, object: { sha: baseSha, type: 'commit' } };
        }
        return null;
      };

      GitHubApiClient.prototype.getFileContent = async (_owner, _repo, filePath) => {
        if (filePath === 'src/app.ts') {
          return {
            name: 'app.ts',
            path: 'src/app.ts',
            sha: 'file-sha-original',
            size: 50,
            content: Buffer.from('export const app = "main";').toString('base64'),
            encoding: 'base64',
          };
        }
        return null; // create file does not exist
      };

      GitHubApiClient.prototype.createCommit = async (_owner, _repo, message, treeSha, parents) => {
        createdCommitMessage = message;
        createdCommitTree = treeSha;
        createdCommitParents = parents;
        return {
          sha: 'new-commit-sha-42-successful',
          tree: { sha: treeSha, url: '' },
          message,
          parents: parents.map((p) => ({ sha: p })),
        };
      };

      GitHubApiClient.prototype.updateRef = async (_owner, _repo, ref, sha) => {
        updatedRef = ref;
        updatedSha = sha;
        return {
          ref: `refs/${ref}`,
          object: { sha, type: 'commit' },
        };
      };

      const result = await GitHubWriteService.commitAndPushChangeset(testChangesetId, testUserId);

      // Verify commit object details
      assert.ok(result);
      assert.strictEqual(result.changesetId, testChangesetId);
      assert.strictEqual(result.branchName, branchName);
      assert.strictEqual(result.commitSha, 'new-commit-sha-42-successful');
      assert.strictEqual(result.status, 'committed');
      assert.ok(result.commitMessage?.includes('[Nodal] Add audit logger service'));
      assert.strictEqual(
        result.commitUrl,
        'https://github.com/testowner/testcommitrepo/commit/new-commit-sha-42-successful'
      );

      // Verify Git Data API call assertions
      assert.strictEqual(createdCommitParents[0], baseSha);
      assert.strictEqual(createdCommitTree, 'staged-tree-sha-42');
      assert.strictEqual(updatedRef, `heads/${branchName}`);
      assert.strictEqual(updatedSha, 'new-commit-sha-42-successful');

      // CRITICAL ASSERTION: Default branch was NOT updated!
      assert.notStrictEqual(updatedRef, 'heads/main');
      assert.notStrictEqual(updatedRef, 'heads/master');

      // Verify persistence in database
      const stored = await GitHubWriteService.getBranchForChangeset(testChangesetId, testUserId);
      assert.ok(stored);
      assert.strictEqual(stored.commitSha, 'new-commit-sha-42-successful');
      assert.strictEqual(stored.status, 'committed');
      assert.ok(stored.committedAt);
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.getFileContent = originalGetFileContent;
      GitHubApiClient.prototype.createCommit = originalCreateCommit;
      GitHubApiClient.prototype.updateRef = originalUpdateRef;
    }
  });

  // Test 8: API Route Authentication POST
  test('8. API Route: Unauthenticated POST /api/changesets/[changesetId]/github/commit returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/commit`,
      { method: 'POST' }
    );
    const response = await postCommitHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });

  // Test 9: API Route Authentication GET
  test('9. API Route: Unauthenticated GET /api/changesets/[changesetId]/github/commit returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/commit`
    );
    const response = await getCommitHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });
});
