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
import { POST as postPrHandler, GET as getPrHandler } from '@/app/api/changesets/[changesetId]/github/pr/route';
import { NextRequest } from 'next/server';

describe('Phase 4.3: GitHub Pull Request Creation & Idempotency Tests', () => {
  const testUserId = 'f4300000-0000-0000-0000-000000000001';
  const otherUserId = 'f4300000-0000-0000-0000-000000000002';
  const testRepoId = `test-repo-gh-pr-${Date.now()}`;
  const testPlanId = `fp-43-${Date.now()}`;
  const testChangesetId = `cs-43-approved-${Date.now()}`;
  const unapprovedChangesetId = `cs-43-ready-${Date.now()}`;
  const uncommittedChangesetId = `cs-43-uncommitted-${Date.now()}`;
  const branchName = `nodal/feature-plan-test43-v1`;
  const commitSha = 'commit-sha-pr-test-1234567890';
  const baseSha = 'base-sha-pr-test-0987654321';

  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureDatabaseSchema();

      await query(`DELETE FROM repositories WHERE id = $1;`, [testRepoId]);

      // 1. Create GitHub-backed repository
      await query(
        `INSERT INTO repositories (
          id, name, full_name, source_type, github_url, user_id, status, branch
        )
        VALUES ($1, 'Test-PR-Repo', 'testowner/testprrepo', 'github', 'https://github.com/testowner/testprrepo', $2, 'COMPLETED', 'main')`,
        [testRepoId, testUserId]
      );

      // 2. Connect test GitHub account
      await GitHubConnectionService.connectGitHubAccount({
        userId: testUserId,
        githubUserId: '99903',
        githubLogin: 'test-pr-user',
        accessToken: 'ghp_test_token_phase_4_3_pr_service',
        avatarUrl: 'https://avatars.githubusercontent.com/u/99903?v=4',
      });

      // 3. Create Feature Plan
      await query(
        `INSERT INTO feature_plans (
          id, repository_id, user_id, feature_request, plan_json, status
        )
        VALUES ($1, $2, $3, 'Add rate limiting middleware', '{"title":"Rate Limiting"}'::jsonb, 'COMPLETED')`,
        [testPlanId, testRepoId, testUserId]
      );

      // 4. Create Approved & Committed Changeset
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 1, 'approved', 'Add Redis rate limiter')`,
        [testChangesetId, testPlanId, testRepoId, testUserId]
      );

      await query(
        `INSERT INTO generated_file_changes (
          id, changeset_id, file_path, change_type, reason, original_content, proposed_content
        )
        VALUES
          ($1, $2, 'src/middleware/rateLimiter.ts', 'create', 'Rate limiter', NULL, 'export class RateLimiter {}')`,
        [`fc-43-1-${Date.now()}`, testChangesetId]
      );

      // Stage and commit the branch
      await query(
        `INSERT INTO changeset_branches (
          changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
          branch_name, base_branch, base_sha, staged_tree_sha, commit_sha, commit_message,
          committed_at, status, file_count
        )
        VALUES ($1, $2, $3, 'testowner', 'testprrepo', $4, 'main', $5, 'staged-tree-43', $6, 'Commit 43', NOW(), 'committed', 1)`,
        [testChangesetId, testRepoId, testUserId, branchName, baseSha, commitSha]
      );

      // 5. Create Unapproved Changeset
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 2, 'ready', 'Unapproved changeset')`,
        [unapprovedChangesetId, testPlanId, testRepoId, testUserId]
      );

      // 6. Create Approved but Uncommitted Changeset
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 3, 'approved', 'Uncommitted changeset')`,
        [uncommittedChangesetId, testPlanId, testRepoId, testUserId]
      );
      await query(
        `INSERT INTO changeset_branches (
          changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
          branch_name, base_branch, base_sha, status, file_count
        )
        VALUES ($1, $2, $3, 'testowner', 'testprrepo', 'nodal/feature-plan-uncommitted-v3', 'main', $4, 'staged', 1)`,
        [uncommittedChangesetId, testRepoId, testUserId, baseSha]
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
  test('1. Rejects Pull Request creation on unapproved changesets', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.createPullRequestForChangeset(unapprovedChangesetId, testUserId);
      assert.fail('Should have thrown an error for unapproved changeset');
    } catch (err: any) {
      assert.ok(err.message.includes('Changeset must be approved before creating a Pull Request'));
    }
  });

  // Test 2: User Isolation
  test('2. Rejects PR creation if user does not own changeset or repository', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.createPullRequestForChangeset(testChangesetId, otherUserId);
      assert.fail('Should have thrown an unauthorized error');
    } catch (err: any) {
      assert.ok(err.message.includes('Unauthorized') || err.message.includes('No GitHub account connected'));
    }
  });

  // Test 3: Validation Blocking
  test('3. Blocks PR creation if changeset validation explicitly failed', async () => {
    if (!process.env.DATABASE_URL) return;

    const valId = `val-failed-${Date.now()}`;
    await query(
      `INSERT INTO changeset_validations (id, changeset_id, repository_id, user_id, status, result)
       VALUES ($1, $2, $3, $4, 'failed', '{"summary":"Build errors"}'::jsonb)`,
      [valId, testChangesetId, testRepoId, testUserId]
    );

    try {
      await GitHubWriteService.createPullRequestForChangeset(testChangesetId, testUserId);
      assert.fail('Should have blocked PR creation due to failed validation');
    } catch (err: any) {
      assert.ok(err.message.includes('Validation FAILED for this changeset'));
    }

    await query(`DELETE FROM changeset_validations WHERE id = $1;`, [valId]);
  });

  // Test 4: Uncommitted Branch Protection
  test('4. Aborts PR creation if changes have not been committed yet', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.createPullRequestForChangeset(uncommittedChangesetId, testUserId);
      assert.fail('Should have thrown error for uncommitted branch');
    } catch (err: any) {
      assert.ok(err.message.includes('Changes have not been committed'));
    }
  });

  // Test 5: Branch Head Verification (Head mismatch)
  test('5. Aborts PR creation if GitHub branch head does not match committed SHA', async () => {
    if (!process.env.DATABASE_URL) return;

    const originalGetRef = GitHubApiClient.prototype.getRef;

    try {
      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === `heads/${branchName}`) {
          return {
            ref: `refs/heads/${branchName}`,
            object: { sha: 'different-upstream-sha', type: 'commit' },
          };
        }
        return null;
      };

      await GitHubWriteService.createPullRequestForChangeset(testChangesetId, testUserId);
      assert.fail('Should have aborted due to branch head mismatch');
    } catch (err: any) {
      assert.ok(err.message.includes('does not match the Nodal commit'));
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
    }
  });

  // Test 6: Successful PR Creation, Default Branch Target, and Persistence
  test('6. Successfully creates Pull Request targeting default branch and persists metadata', async () => {
    if (!process.env.DATABASE_URL) return;

    let prHead = '';
    let prBase = '';
    let prTitle = '';
    let prBody = '';

    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalListPRs = GitHubApiClient.prototype.listPullRequests;
    const originalCreatePR = GitHubApiClient.prototype.createPullRequest;

    try {
      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === `heads/${branchName}`) {
          return { ref: `refs/heads/${branchName}`, object: { sha: commitSha, type: 'commit' } };
        }
        return null;
      };

      GitHubApiClient.prototype.listPullRequests = async () => [];

      GitHubApiClient.prototype.createPullRequest = async (_owner, _repo, title, head, base, body) => {
        prTitle = title;
        prHead = head;
        prBase = base;
        prBody = body || '';
        return {
          id: 42001,
          number: 101,
          html_url: 'https://github.com/testowner/testprrepo/pull/101',
          url: 'https://api.github.com/repos/testowner/testprrepo/pulls/101',
          title,
          body: body || null,
          state: 'open',
          head: { ref: head, sha: commitSha },
          base: { ref: base, sha: baseSha },
        };
      };

      const pr = await GitHubWriteService.createPullRequestForChangeset(testChangesetId, testUserId);

      // Verify PR details
      assert.ok(pr);
      assert.strictEqual(pr.changesetId, testChangesetId);
      assert.strictEqual(pr.githubPrNumber, 101);
      assert.strictEqual(pr.githubPrUrl, 'https://github.com/testowner/testprrepo/pull/101');
      assert.strictEqual(pr.status, 'open');
      assert.strictEqual(pr.branchName, branchName);
      assert.strictEqual(pr.baseBranch, 'main');
      assert.strictEqual(pr.commitSha, commitSha);

      // CRITICAL ASSERTIONS: Head and base branches
      assert.strictEqual(prHead, branchName);
      assert.strictEqual(prBase, 'main');
      assert.notStrictEqual(prHead, 'main'); // Head is NEVER default branch

      // Verify deterministic title and body
      assert.ok(prTitle.includes('[Nodal]'));
      assert.ok(prBody.includes('## Summary'));
      assert.ok(prBody.includes('## Changes'));
      assert.ok(prBody.includes('## Validation Summary'));
      assert.ok(prBody.includes('*Generated with Nodal •'));
      assert.ok(!prBody.includes('[CodeGraph](https://github.com/)'));
      assert.ok(!prBody.includes('[Nodal](https://github.com/)'));

      // Verify persistence in pull_requests table
      const stored = await GitHubWriteService.getPullRequestForChangeset(testChangesetId, testUserId);
      assert.ok(stored);
      assert.strictEqual(stored.githubPrNumber, 101);
      assert.strictEqual(stored.githubPrUrl, 'https://github.com/testowner/testprrepo/pull/101');

      // Verify changeset_branches status updated to 'pr_created'
      const branchRecord = await GitHubWriteService.getBranchForChangeset(testChangesetId, testUserId);
      assert.ok(branchRecord);
      assert.strictEqual(branchRecord.status, 'pr_created');
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.listPullRequests = originalListPRs;
      GitHubApiClient.prototype.createPullRequest = originalCreatePR;
    }
  });

  // Test 7: Idempotency (Local Database)
  test('7. Idempotency: Repeated calls return existing pull_requests record without creating duplicates', async () => {
    if (!process.env.DATABASE_URL) return;

    let createPRCallCount = 0;
    const originalCreatePR = GitHubApiClient.prototype.createPullRequest;

    try {
      GitHubApiClient.prototype.createPullRequest = async () => {
        createPRCallCount++;
        throw new Error('Should not be called when PR already exists in database');
      };

      const pr = await GitHubWriteService.createPullRequestForChangeset(testChangesetId, testUserId);

      assert.ok(pr);
      assert.strictEqual(pr.githubPrNumber, 101);
      assert.strictEqual(createPRCallCount, 0); // Confirms GitHub API was NOT called again
    } finally {
      GitHubApiClient.prototype.createPullRequest = originalCreatePR;
    }
  });

  // Test 8: Idempotency (GitHub Upstream Detection)
  test('8. Idempotency: Detects existing open PR on GitHub and links it without creating duplicates', async () => {
    if (!process.env.DATABASE_URL) return;

    // Create a fresh approved and committed changeset
    const freshCsId = `cs-43-upstream-pr-${Date.now()}`;
    const freshBranch = `nodal/feature-plan-upstream-v1`;

    await query(
      `INSERT INTO generated_changesets (id, feature_plan_id, repository_id, user_id, version, status, summary)
       VALUES ($1, $2, $3, $4, 1, 'approved', 'Upstream PR test')`,
      [freshCsId, testPlanId, testRepoId, testUserId]
    );

    await query(
      `INSERT INTO generated_file_changes (id, changeset_id, file_path, change_type, reason, proposed_content)
       VALUES ($1, $2, 'file.txt', 'create', 'test', 'hello')`,
      [`fc-43-fresh-${Date.now()}`, freshCsId]
    );

    await query(
      `INSERT INTO changeset_branches (
        changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
        branch_name, base_branch, base_sha, commit_sha, status, file_count
      )
      VALUES ($1, $2, $3, 'testowner', 'testprrepo', $4, 'main', $5, $6, 'committed', 1)`,
      [freshCsId, testRepoId, testUserId, freshBranch, baseSha, commitSha]
    );

    let createPRCallCount = 0;
    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalListPRs = GitHubApiClient.prototype.listPullRequests;
    const originalCreatePR = GitHubApiClient.prototype.createPullRequest;

    try {
      GitHubApiClient.prototype.getRef = async () => ({
        ref: `refs/heads/${freshBranch}`,
        object: { sha: commitSha, type: 'commit' },
      });

      // Simulate that GitHub already has a PR open for this branch
      GitHubApiClient.prototype.listPullRequests = async () => [
        {
          id: 42099,
          number: 202,
          html_url: 'https://github.com/testowner/testprrepo/pull/202',
          url: 'https://api.github.com/repos/testowner/testprrepo/pulls/202',
          title: '[Nodal] Upstream PR test',
          body: 'Already created',
          state: 'open',
          head: { ref: freshBranch, sha: commitSha },
          base: { ref: 'main', sha: baseSha },
        },
      ];

      GitHubApiClient.prototype.createPullRequest = async () => {
        createPRCallCount++;
        throw new Error('Should not create duplicate PR on GitHub');
      };

      const pr = await GitHubWriteService.createPullRequestForChangeset(freshCsId, testUserId);

      assert.ok(pr);
      assert.strictEqual(pr.githubPrNumber, 202);
      assert.strictEqual(pr.githubPrUrl, 'https://github.com/testowner/testprrepo/pull/202');
      assert.strictEqual(createPRCallCount, 0); // Confirmed: no duplicate PR created!
    } finally {
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.listPullRequests = originalListPRs;
      GitHubApiClient.prototype.createPullRequest = originalCreatePR;
    }
  });

  // Test 9: API Route Authentication POST
  test('9. API Route: Unauthenticated POST /api/changesets/[changesetId]/github/pr returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/pr`,
      { method: 'POST' }
    );
    const response = await postPrHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });

  // Test 10: API Route Authentication GET
  test('10. API Route: Unauthenticated GET /api/changesets/[changesetId]/github/pr returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/pr`
    );
    const response = await getPrHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });
});
