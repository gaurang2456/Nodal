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
import { POST as postBranchHandler, GET as getBranchHandler } from '@/app/api/changesets/[changesetId]/github/branch/route';
import { NextRequest } from 'next/server';

describe('Phase 4.1: GitHub Branch Creation, Drift Detection & Changeset Staging Tests', () => {
  const testUserId = 'f4100000-0000-0000-0000-000000000001';
  const otherUserId = 'f4100000-0000-0000-0000-000000000002';
  const testRepoId = `test-repo-gh-branch-${Date.now()}`;
  const zipRepoId = `test-repo-zip-${Date.now()}`;
  const testPlanId = `fp-41-${Date.now()}`;
  const testChangesetId = `cs-41-approved-${Date.now()}`;
  const unapprovedChangesetId = `cs-41-ready-${Date.now()}`;

  before(async () => {
    if (process.env.DATABASE_URL) {
      await ensureDatabaseSchema();

      // Clean old test records
      await query(`DELETE FROM repositories WHERE id IN ($1, $2);`, [testRepoId, zipRepoId]);

      // 1. Create GitHub-backed repository
      await query(
        `INSERT INTO repositories (
          id, name, full_name, source_type, github_url, user_id, status, branch
        )
        VALUES ($1, 'Test-GH-Repo', 'testowner/testrepo', 'github', 'https://github.com/testowner/testrepo', $2, 'COMPLETED', 'main')`,
        [testRepoId, testUserId]
      );

      // 2. Create ZIP-backed repository (to test non-GitHub rejection)
      await query(
        `INSERT INTO repositories (
          id, name, full_name, source_type, user_id, status
        )
        VALUES ($1, 'Test-Zip-Repo', 'uploads/testzip', 'zip', $2, 'COMPLETED')`,
        [zipRepoId, testUserId]
      );

      // 3. Connect test GitHub account
      await GitHubConnectionService.connectGitHubAccount({
        userId: testUserId,
        githubUserId: '99901',
        githubLogin: 'test-dev-user',
        accessToken: 'ghp_test_token_phase_4_1_write_service',
        avatarUrl: 'https://avatars.githubusercontent.com/u/99901?v=4',
      });

      // 4. Create Feature Plan
      await query(
        `INSERT INTO feature_plans (
          id, repository_id, user_id, feature_request, plan_json, status
        )
        VALUES ($1, $2, $3, 'Add user notifications', '{"title":"Notifications"}'::jsonb, 'COMPLETED')`,
        [testPlanId, testRepoId, testUserId]
      );

      // 5. Create Approved Changeset
      await query(
        `INSERT INTO generated_changesets (
          id, feature_plan_id, repository_id, user_id, version, status, summary
        )
        VALUES ($1, $2, $3, $4, 1, 'approved', 'Add notifications module')`,
        [testChangesetId, testPlanId, testRepoId, testUserId]
      );

      // Add file changes to approved changeset
      await query(
        `INSERT INTO generated_file_changes (
          id, changeset_id, file_path, change_type, reason, original_content, proposed_content
        )
        VALUES
          ($1, $2, 'src/services/notificationService.ts', 'create', 'Create notification service', NULL, 'export class NotificationService {}'),
          ($3, $2, 'src/index.ts', 'modify', 'Export notification service', 'export const version = "1.0";', 'export const version = "1.0";\nexport * from "./services/notificationService";')`,
        [`fc-1-${Date.now()}`, testChangesetId, `fc-2-${Date.now()}`]
      );

      // 6. Create Unapproved Changeset (status: 'ready')
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
        [`fc-3-${Date.now()}`, unapprovedChangesetId]
      );
    }
  });

  after(async () => {
    if (process.env.DATABASE_URL) {
      await query(`DELETE FROM repositories WHERE id IN ($1, $2);`, [testRepoId, zipRepoId]);
      await query(`DELETE FROM github_connections WHERE user_id = $1;`, [testUserId]);
    }
  });

  // Test 1: Approval Enforcement
  test('1. Rejects unapproved changesets (status !== approved)', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.createBranchAndStageChangeset(unapprovedChangesetId, testUserId);
      assert.fail('Should have thrown an error for unapproved changeset');
    } catch (err: any) {
      assert.ok(err.message.includes('Changeset must be approved before creating a GitHub branch'));
    }
  });

  // Test 2: User Isolation
  test('2. Rejects branch creation if user does not own changeset or repository', async () => {
    if (!process.env.DATABASE_URL) return;

    try {
      await GitHubWriteService.createBranchAndStageChangeset(testChangesetId, otherUserId);
      assert.fail('Should have thrown an unauthorized error');
    } catch (err: any) {
      assert.ok(err.message.includes('Unauthorized') || err.message.includes('No GitHub account connected'));
    }
  });

  // Test 3: Non-GitHub Repository Rejection
  test('3. Rejects branch creation for non-GitHub (e.g. ZIP upload) repositories', async () => {
    if (!process.env.DATABASE_URL) return;

    // Create an approved changeset on the ZIP repo
    const zipPlanId = `fp-zip-${Date.now()}`;
    const zipChangesetId = `cs-zip-${Date.now()}`;

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json)
       VALUES ($1, $2, $3, 'Zip feature', '{}'::jsonb)`,
      [zipPlanId, zipRepoId, testUserId]
    );

    await query(
      `INSERT INTO generated_changesets (id, feature_plan_id, repository_id, user_id, version, status, summary)
       VALUES ($1, $2, $3, $4, 1, 'approved', 'Zip changeset')`,
      [zipChangesetId, zipPlanId, zipRepoId, testUserId]
    );

    await query(
      `INSERT INTO generated_file_changes (id, changeset_id, file_path, change_type, reason, proposed_content)
       VALUES ($1, $2, 'file.txt', 'create', 'test', 'hello')`,
      [`fc-zip-${Date.now()}`, zipChangesetId]
    );

    try {
      await GitHubWriteService.createBranchAndStageChangeset(zipChangesetId, testUserId);
      assert.fail('Should have thrown an error for non-GitHub repo');
    } catch (err: any) {
      assert.ok(err.message.includes('Only GitHub-backed repositories support automatic branch creation'));
    }
  });

  // Test 4: Validation Model Blocking
  test('4. Blocks branch creation if changeset validation explicitly failed or errored', async () => {
    if (!process.env.DATABASE_URL) return;

    const valId = `val-failed-${Date.now()}`;
    // Insert a failed validation
    await query(
      `INSERT INTO changeset_validations (id, changeset_id, repository_id, user_id, status, result)
       VALUES ($1, $2, $3, $4, 'failed', '{"summary":"Build errors"}'::jsonb)`,
      [valId, testChangesetId, testRepoId, testUserId]
    );

    try {
      await GitHubWriteService.createBranchAndStageChangeset(testChangesetId, testUserId);
      assert.fail('Should have blocked branch creation due to failed validation');
    } catch (err: any) {
      assert.ok(err.message.includes('Validation FAILED for this changeset'));
    }

    // Clean up failed validation
    await query(`DELETE FROM changeset_validations WHERE id = $1;`, [valId]);
  });

  // Test 5: Validation Model Acceptance (Skipped or Passed)
  test('5. Allows branch creation when validation status is skipped', async () => {
    if (!process.env.DATABASE_URL) return;

    const valId = `val-skipped-${Date.now()}`;
    await query(
      `INSERT INTO changeset_validations (id, changeset_id, repository_id, user_id, status, result)
       VALUES ($1, $2, $3, $4, 'skipped', '{"summary":"Skipped (no tsconfig)"}'::jsonb)`,
      [valId, testChangesetId, testRepoId, testUserId]
    );

    // Mock GitHubApiClient methods on the class prototype to simulate GitHub responses
    const originalGetRepo = GitHubApiClient.prototype.getRepository;
    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalGetCommit = GitHubApiClient.prototype.getCommit;
    const originalGetFileContent = GitHubApiClient.prototype.getFileContent;
    const originalCreateRef = GitHubApiClient.prototype.createRef;
    const originalCreateBlob = GitHubApiClient.prototype.createBlob;
    const originalCreateTree = GitHubApiClient.prototype.createTree;

    try {
      GitHubApiClient.prototype.getRepository = async () => ({
        id: 12345,
        name: 'testrepo',
        full_name: 'testowner/testrepo',
        private: false,
        html_url: 'https://github.com/testowner/testrepo',
        default_branch: 'main',
        permissions: { admin: true, push: true, pull: true },
      });

      GitHubApiClient.prototype.getRef = async (_owner, _repo, ref) => {
        if (ref === 'heads/main') {
          return { ref: 'refs/heads/main', object: { sha: 'base-sha-1234567890abcdef', type: 'commit' } };
        }
        return null; // feature branch does not exist yet
      };

      GitHubApiClient.prototype.getCommit = async () => ({
        sha: 'base-sha-1234567890abcdef',
        tree: { sha: 'base-tree-sha-abcdef', url: '' },
        message: 'Initial commit',
        parents: [],
      });

      // Simulate GitHub file content for drift detection
      GitHubApiClient.prototype.getFileContent = async (_owner, _repo, filePath) => {
        if (filePath === 'src/index.ts') {
          // Exactly matches change.originalContent
          return {
            name: 'index.ts',
            path: 'src/index.ts',
            sha: 'file-sha-1',
            size: 50,
            content: Buffer.from('export const version = "1.0";').toString('base64'),
            encoding: 'base64',
          };
        }
        return null; // create file does not exist on GitHub
      };

      GitHubApiClient.prototype.createRef = async (_owner, _repo, ref, sha) => ({
        ref,
        object: { sha, type: 'commit' },
      });

      GitHubApiClient.prototype.createBlob = async () => ({
        sha: 'blob-sha-new-123',
        url: '',
      });

      GitHubApiClient.prototype.createTree = async () => ({
        sha: 'staged-tree-sha-999',
        url: '',
      });

      const branch = await GitHubWriteService.createBranchAndStageChangeset(testChangesetId, testUserId);

      assert.ok(branch);
      assert.strictEqual(branch.changesetId, testChangesetId);
      assert.strictEqual(branch.baseBranch, 'main');
      assert.strictEqual(branch.baseSha, 'base-sha-1234567890abcdef');
      assert.strictEqual(branch.stagedTreeSha, 'staged-tree-sha-999');
      assert.strictEqual(branch.status, 'staged');
      assert.strictEqual(branch.fileCount, 2);
      assert.ok(branch.branchName.startsWith('codegraph/feature-plan-'));

      // Verify persistence in changeset_branches table
      const stored = await GitHubWriteService.getBranchForChangeset(testChangesetId, testUserId);
      assert.ok(stored);
      assert.strictEqual(stored.branchName, branch.branchName);
      assert.strictEqual(stored.stagedTreeSha, 'staged-tree-sha-999');
    } finally {
      // Restore methods
      GitHubApiClient.prototype.getRepository = originalGetRepo;
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.getCommit = originalGetCommit;
      GitHubApiClient.prototype.getFileContent = originalGetFileContent;
      GitHubApiClient.prototype.createRef = originalCreateRef;
      GitHubApiClient.prototype.createBlob = originalCreateBlob;
      GitHubApiClient.prototype.createTree = originalCreateTree;
      await query(`DELETE FROM changeset_validations WHERE id = $1;`, [valId]);
    }
  });

  // Test 6: Critical Drift Detection (Upstream file modified)
  test('6. Drift Detection: Aborts if upstream file has been modified on GitHub', async () => {
    if (!process.env.DATABASE_URL) return;

    const originalGetRepo = GitHubApiClient.prototype.getRepository;
    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalGetCommit = GitHubApiClient.prototype.getCommit;
    const originalGetFileContent = GitHubApiClient.prototype.getFileContent;

    try {
      GitHubApiClient.prototype.getRepository = async () => ({
        id: 12345,
        name: 'testrepo',
        full_name: 'testowner/testrepo',
        private: false,
        html_url: 'https://github.com/testowner/testrepo',
        default_branch: 'main',
        permissions: { admin: true, push: true, pull: true },
      });

      GitHubApiClient.prototype.getRef = async () => ({
        ref: 'refs/heads/main',
        object: { sha: 'base-sha-drift', type: 'commit' },
      });

      GitHubApiClient.prototype.getCommit = async () => ({
        sha: 'base-sha-drift',
        tree: { sha: 'base-tree-sha', url: '' },
        message: 'Initial',
        parents: [],
      });

      // Simulate drift: file on GitHub has changed to version "2.0"
      GitHubApiClient.prototype.getFileContent = async (_owner, _repo, filePath) => {
        if (filePath === 'src/index.ts') {
          return {
            name: 'index.ts',
            path: 'src/index.ts',
            sha: 'file-sha-drift',
            size: 50,
            content: Buffer.from('export const version = "2.0-MODIFIED-UPSTREAM";').toString('base64'),
            encoding: 'base64',
          };
        }
        return null;
      };

      await GitHubWriteService.createBranchAndStageChangeset(testChangesetId, testUserId);
      assert.fail('Should have detected drift and aborted');
    } catch (err: any) {
      assert.ok(err.message.includes('Repository drift detected'));
      assert.ok(err.message.includes('src/index.ts'));
    } finally {
      GitHubApiClient.prototype.getRepository = originalGetRepo;
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.getCommit = originalGetCommit;
      GitHubApiClient.prototype.getFileContent = originalGetFileContent;
    }
  });

  // Test 7: Critical Drift Detection (Create conflict)
  test('7. Drift Detection: Aborts if create target already exists on GitHub', async () => {
    if (!process.env.DATABASE_URL) return;

    const originalGetRepo = GitHubApiClient.prototype.getRepository;
    const originalGetRef = GitHubApiClient.prototype.getRef;
    const originalGetCommit = GitHubApiClient.prototype.getCommit;
    const originalGetFileContent = GitHubApiClient.prototype.getFileContent;

    try {
      GitHubApiClient.prototype.getRepository = async () => ({
        id: 12345,
        name: 'testrepo',
        full_name: 'testowner/testrepo',
        private: false,
        html_url: 'https://github.com/testowner/testrepo',
        default_branch: 'main',
        permissions: { admin: true, push: true, pull: true },
      });

      GitHubApiClient.prototype.getRef = async () => ({
        ref: 'refs/heads/main',
        object: { sha: 'base-sha-conflict', type: 'commit' },
      });

      GitHubApiClient.prototype.getCommit = async () => ({
        sha: 'base-sha-conflict',
        tree: { sha: 'base-tree-sha', url: '' },
        message: 'Initial',
        parents: [],
      });

      // Simulate that the file we planned to create already exists!
      GitHubApiClient.prototype.getFileContent = async (_owner, _repo, filePath) => {
        if (filePath === 'src/services/notificationService.ts') {
          return {
            name: 'notificationService.ts',
            path: 'src/services/notificationService.ts',
            sha: 'already-existing-file-sha',
            size: 100,
            content: Buffer.from('// already created by another developer').toString('base64'),
            encoding: 'base64',
          };
        }
        if (filePath === 'src/index.ts') {
          return {
            name: 'index.ts',
            path: 'src/index.ts',
            sha: 'file-sha-1',
            size: 50,
            content: Buffer.from('export const version = "1.0";').toString('base64'),
            encoding: 'base64',
          };
        }
        return null;
      };

      await GitHubWriteService.createBranchAndStageChangeset(testChangesetId, testUserId);
      assert.fail('Should have detected create collision and aborted');
    } catch (err: any) {
      assert.ok(err.message.includes('Repository drift detected'));
      assert.ok(err.message.includes('already exists on GitHub'));
    } finally {
      GitHubApiClient.prototype.getRepository = originalGetRepo;
      GitHubApiClient.prototype.getRef = originalGetRef;
      GitHubApiClient.prototype.getCommit = originalGetCommit;
      GitHubApiClient.prototype.getFileContent = originalGetFileContent;
    }
  });

  // Test 8: API Route Authentication
  test('8. API Route: Unauthenticated POST /api/changesets/[changesetId]/github/branch returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/branch`,
      { method: 'POST' }
    );
    const response = await postBranchHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });

  // Test 9: API Route Authentication GET
  test('9. API Route: Unauthenticated GET /api/changesets/[changesetId]/github/branch returns 401', async () => {
    const unauthReq = new NextRequest(
      `http://localhost:3000/api/changesets/${testChangesetId}/github/branch`
    );
    const response = await getBranchHandler(unauthReq, {
      params: Promise.resolve({ changesetId: testChangesetId }),
    });

    assert.strictEqual(response.status, 401);
  });

  // Test 10: Branch safety guards & issue branch naming
  test('10. Safety Guards & Branch Naming: blocks default/protected branches and uses codegraph/<issue>-<slug>', () => {
    assert.throws(
      () => GitHubWriteService.assertSafeTargetBranch('main', 'main'),
      /default or protected branch/i
    );
    assert.throws(
      () => GitHubWriteService.assertSafeTargetBranch('master', 'trunk'),
      /default or protected branch/i
    );
    assert.throws(
      () => GitHubWriteService.assertSafeTargetBranch('custom-default', 'custom-default'),
      /default or protected branch/i
    );
    assert.throws(
      () => GitHubWriteService.assertSafeTargetBranch('codegraph/feature', 'main', true),
      /default or protected branch/i
    );
    assert.throws(
      () => GitHubWriteService.assertSafeTargetBranch('feature/foo', 'main'),
      /must be under the 'codegraph\/' namespace/i
    );

    // Safe codegraph/ branches pass
    GitHubWriteService.assertSafeTargetBranch('codegraph/42-profile-edit-button', 'main', false);

    // Issue-linked branch naming
    const issueBranch = GitHubWriteService.buildBranchName({
      featurePlanId: 'fp-123456',
      changesetVersion: 1,
      issueNumber: 42,
      issueTitle: 'Profile.js: Edit button is non-functional!',
    });
    assert.strictEqual(issueBranch, 'codegraph/42-profile-js-edit-button-is-non-functional');
  });

  // Test 11: Contributor fork-first workflow (branches at upstreamHeadSha before sync, detects upstream moved, cross-repo PR)
  test('11. Contributor Fork Flow: creates fork, branches before sync, warns if upstream moved, opens cross-repo PR', async () => {
    if (!process.env.DATABASE_URL) return;

    const forkRepoId = `test-repo-fork-${Date.now()}`;
    const forkPlanId = `fp-fork-${Date.now()}`;
    const forkCsId = `cs-fork-${Date.now()}`;
    const callOrder: string[] = [];
    let syncCalled = 0;
    let capturedPrHead = '';
    let capturedPrOwner = '';
    let capturedPrBody = '';

    await query(
      `INSERT INTO repositories (
        id, name, full_name, source_type, github_url, user_id, status, branch, indexed_commit_sha
      )
      VALUES ($1, 'StudyMatePlus', 'upstream-org/StudyMatePlus', 'github', 'https://github.com/upstream-org/StudyMatePlus', $2, 'COMPLETED', 'main', 'indexed-sha-0001')`,
      [forkRepoId, testUserId]
    );
    await query(
      `INSERT INTO feature_plans (
        id, repository_id, user_id, feature_request, issue_number, issue_title, plan_json, status
      )
      VALUES ($1, $2, $3, 'Profile.js: Edit button is non-functional', 42, 'Profile.js: Edit button is non-functional', '{"overview":"Fix edit button"}'::jsonb, 'COMPLETED')`,
      [forkPlanId, forkRepoId, testUserId]
    );
    await query(
      `INSERT INTO generated_changesets (
        id, feature_plan_id, repository_id, user_id, version, status, summary
      )
      VALUES ($1, $2, $3, $4, 1, 'ready', 'Wire Profile Edit button click handler')`,
      [forkCsId, forkPlanId, forkRepoId, testUserId]
    );
    await query(
      `INSERT INTO generated_file_changes (
        id, changeset_id, file_path, change_type, reason, original_content, proposed_content
      )
      VALUES ($1, $2, 'client/src/pages/Profile.js', 'modify', 'Enable edit toggle', 'export const Profile = () => false;', 'export const Profile = () => true;')`,
      [`fc-fork-${Date.now()}`, forkCsId]
    );

    const originals = {
      getRepository: GitHubApiClient.prototype.getRepository,
      getUser: GitHubApiClient.prototype.getUser,
      createFork: GitHubApiClient.prototype.createFork,
      getRef: GitHubApiClient.prototype.getRef,
      syncForkUpstream: GitHubApiClient.prototype.syncForkUpstream,
      createRef: GitHubApiClient.prototype.createRef,
      getFileContent: GitHubApiClient.prototype.getFileContent,
      getCommit: GitHubApiClient.prototype.getCommit,
      createBlob: GitHubApiClient.prototype.createBlob,
      createTree: GitHubApiClient.prototype.createTree,
      createCommit: GitHubApiClient.prototype.createCommit,
      updateRef: GitHubApiClient.prototype.updateRef,
      listPullRequests: GitHubApiClient.prototype.listPullRequests,
      createPullRequest: GitHubApiClient.prototype.createPullRequest,
    };

    try {
      GitHubApiClient.prototype.getRepository = async () => ({
        id: 555,
        name: 'StudyMatePlus',
        full_name: 'upstream-org/StudyMatePlus',
        private: false,
        html_url: 'https://github.com/upstream-org/StudyMatePlus',
        default_branch: 'main',
        permissions: { admin: false, push: false, pull: true },
      });

      GitHubApiClient.prototype.getUser = async () => ({
        id: 99901,
        login: 'test-dev-user',
        avatar_url: '',
        html_url: 'https://github.com/test-dev-user',
      });

      GitHubApiClient.prototype.createFork = async () => {
        callOrder.push('createFork');
        return {
          id: 777,
          name: 'StudyMatePlus',
          full_name: 'test-dev-user/StudyMatePlus',
          private: false,
          html_url: 'https://github.com/test-dev-user/StudyMatePlus',
          default_branch: 'main',
          fork: true,
        };
      };

      GitHubApiClient.prototype.getRef = async (owner, _repo, ref) => {
        if (owner === 'upstream-org' && ref === 'heads/main') {
          return { ref: 'refs/heads/main', object: { sha: 'upstream-live-sha-999', type: 'commit' } };
        }
        if (owner === 'test-dev-user' && ref === 'heads/main') {
          return { ref: 'refs/heads/main', object: { sha: 'fork-old-sha-111', type: 'commit' } };
        }
        if (owner === 'test-dev-user' && ref.startsWith('heads/codegraph/42-')) {
          return callOrder.includes('createCommit')
            ? { ref: `refs/${ref}`, object: { sha: 'new-pr-commit-sha', type: 'commit' } }
            : callOrder.some((c) => c.startsWith('createRef:'))
            ? { ref: `refs/${ref}`, object: { sha: 'upstream-live-sha-999', type: 'commit' } }
            : null;
        }
        return null;
      };

      GitHubApiClient.prototype.createRef = async (_owner, _repo, ref, sha) => {
        callOrder.push(`createRef:${sha}`);
        // Succeed immediately on upstreamHeadSha so syncForkUpstream is never needed!
        return { ref, object: { sha, type: 'commit' } };
      };

      GitHubApiClient.prototype.syncForkUpstream = async () => {
        syncCalled++;
        callOrder.push('syncForkUpstream');
        return { ok: true, status: 200 };
      };

      GitHubApiClient.prototype.getFileContent = async () => ({
        name: 'Profile.js',
        path: 'client/src/pages/Profile.js',
        sha: 'file-sha-profile',
        size: 32,
        content: Buffer.from('export const Profile = () => false;').toString('base64'),
        encoding: 'base64',
      });

      GitHubApiClient.prototype.getCommit = async () => ({
        sha: 'upstream-live-sha-999',
        tree: { sha: 'base-tree-sha', url: '' },
        message: 'upstream tip',
        parents: [],
      });

      GitHubApiClient.prototype.createBlob = async () => ({ sha: 'blob-sha-42', url: '' });
      GitHubApiClient.prototype.createTree = async () => ({ sha: 'tree-sha-42', url: '' });
      GitHubApiClient.prototype.createCommit = async () => {
        callOrder.push('createCommit');
        return {
          sha: 'new-pr-commit-sha',
          tree: { sha: 'tree-sha-42', url: '' },
          message: 'commit',
          parents: [{ sha: 'upstream-live-sha-999', url: '' }],
        };
      };
      GitHubApiClient.prototype.updateRef = async (_o, _r, ref, sha, force) => {
        assert.strictEqual(force, false, 'Must never force-push');
        return { ref, object: { sha, type: 'commit' } };
      };
      GitHubApiClient.prototype.listPullRequests = async () => [];
      GitHubApiClient.prototype.createPullRequest = async (owner, _repo, title, head, base, body) => {
        capturedPrOwner = owner;
        capturedPrHead = head;
        capturedPrBody = body || '';
        return {
          id: 88801,
          number: 77,
          html_url: `https://github.com/${owner}/StudyMatePlus/pull/77`,
          url: '',
          title,
          body: body || '',
          state: 'open',
          head: { ref: head, sha: 'new-pr-commit-sha' },
          base: { ref: base, sha: 'upstream-live-sha-999' },
        };
      };

      const result = await GitHubWriteService.oneClickCreatePullRequest(forkCsId, testUserId, {
        autoApprove: true,
      });

      assert.strictEqual(syncCalled, 0, 'Must branch from upstreamHeadSha before calling syncForkUpstream');
      assert.strictEqual(callOrder[0], 'createFork');
      assert.ok(callOrder.includes('createRef:upstream-live-sha-999'));
      assert.strictEqual(result.branch.githubRepoOwner, 'test-dev-user');
      assert.ok(result.branch.branchName.startsWith('codegraph/42-'));
      assert.strictEqual(result.branch.metadata?.isFork, true);
      assert.ok(
        String(result.branch.metadata?.upstreamMovedWarning || '').includes('moved since indexing'),
        'Must warn when indexed_commit_sha differs from live upstream HEAD'
      );
      assert.strictEqual(capturedPrOwner, 'upstream-org');
      assert.ok(capturedPrHead.startsWith('test-dev-user:codegraph/42-'));
      assert.ok(capturedPrBody.includes('Fixes #42'), 'PR body must link issue #42');
      assert.strictEqual(result.pullRequest.isFork, true);
      assert.strictEqual(result.pullRequest.headOwner, 'test-dev-user');
    } finally {
      Object.assign(GitHubApiClient.prototype, originals);
      await query(`DELETE FROM repositories WHERE id = $1`, [forkRepoId]);
    }
  });

  // Test 12: Graceful fork merge-upstream 409 conflict fallback
  test('12. Fork Sync 409 Conflict: falls back safely to non-drifted indexed commit SHA or reports actionable conflict', async () => {
    if (!process.env.DATABASE_URL) return;

    const repo409Id = `test-repo-409-${Date.now()}`;
    const plan409Id = `fp-409-${Date.now()}`;
    const cs409Id = `cs-409-${Date.now()}`;

    await query(
      `INSERT INTO repositories (
        id, name, full_name, source_type, github_url, user_id, status, branch, indexed_commit_sha
      )
      VALUES ($1, 'StudyMatePlus', 'upstream-org/StudyMatePlus', 'github', 'https://github.com/upstream-org/StudyMatePlus', $2, 'COMPLETED', 'main', 'indexed-safe-sha')`,
      [repo409Id, testUserId]
    );
    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, issue_number, plan_json, status)
       VALUES ($1, $2, $3, 'Fix Profile', 99, '{}'::jsonb, 'COMPLETED')`,
      [plan409Id, repo409Id, testUserId]
    );
    await query(
      `INSERT INTO generated_changesets (id, feature_plan_id, repository_id, user_id, version, status, summary)
       VALUES ($1, $2, $3, $4, 1, 'approved', 'Safe fallback')`,
      [cs409Id, plan409Id, repo409Id, testUserId]
    );
    await query(
      `INSERT INTO generated_file_changes (id, changeset_id, file_path, change_type, reason, original_content, proposed_content)
       VALUES ($1, $2, 'src/a.ts', 'modify', 'Update', 'export const a = 1;', 'export const a = 2;')`,
      [`fc-409-${Date.now()}`, cs409Id]
    );

    const originals = {
      getRepository: GitHubApiClient.prototype.getRepository,
      getUser: GitHubApiClient.prototype.getUser,
      createFork: GitHubApiClient.prototype.createFork,
      getRef: GitHubApiClient.prototype.getRef,
      syncForkUpstream: GitHubApiClient.prototype.syncForkUpstream,
      createRef: GitHubApiClient.prototype.createRef,
      getFileContent: GitHubApiClient.prototype.getFileContent,
      getCommit: GitHubApiClient.prototype.getCommit,
      createBlob: GitHubApiClient.prototype.createBlob,
      createTree: GitHubApiClient.prototype.createTree,
    };

    try {
      GitHubApiClient.prototype.getRepository = async () => ({
        id: 556,
        name: 'StudyMatePlus',
        full_name: 'upstream-org/StudyMatePlus',
        private: false,
        html_url: 'https://github.com/upstream-org/StudyMatePlus',
        default_branch: 'main',
        permissions: { admin: false, push: false, pull: true },
      });
      GitHubApiClient.prototype.getUser = async () => ({
        id: 99901,
        login: 'test-dev-user',
        avatar_url: '',
        html_url: 'https://github.com/test-dev-user',
      });
      GitHubApiClient.prototype.createFork = async () => ({
        id: 778,
        name: 'StudyMatePlus',
        full_name: 'test-dev-user/StudyMatePlus',
        private: false,
        html_url: 'https://github.com/test-dev-user/StudyMatePlus',
        default_branch: 'main',
        fork: true,
      });
      GitHubApiClient.prototype.getRef = async (owner, _repo, ref) => {
        if (owner === 'upstream-org' && ref === 'heads/main') {
          return { ref: 'refs/heads/main', object: { sha: 'upstream-tip-missing-in-fork', type: 'commit' } };
        }
        if (owner === 'test-dev-user' && ref === 'heads/main') {
          return { ref: 'refs/heads/main', object: { sha: 'fork-diverged-sha', type: 'commit' } };
        }
        return null;
      };
      GitHubApiClient.prototype.createRef = async (_owner, _repo, ref, sha) => {
        // First attempt at upstreamHeadSha fails (422 commit missing on fork)
        if (sha === 'upstream-tip-missing-in-fork') {
          throw new Error('GitHub API request failed [422]: Reference cannot be created');
        }
        return { ref, object: { sha, type: 'commit' } };
      };
      GitHubApiClient.prototype.syncForkUpstream = async () => ({
        ok: false,
        status: 409,
        message: 'Merge conflict on unrelated README.md',
      });
      GitHubApiClient.prototype.getFileContent = async () => ({
        name: 'a.ts',
        path: 'src/a.ts',
        sha: 'file-sha-a',
        size: 18,
        content: Buffer.from('export const a = 1;').toString('base64'),
        encoding: 'base64',
      });
      GitHubApiClient.prototype.getCommit = async () => ({
        sha: 'indexed-safe-sha',
        tree: { sha: 'tree-indexed-safe', url: '' },
        message: 'indexed commit',
        parents: [],
      });
      GitHubApiClient.prototype.createBlob = async () => ({ sha: 'blob-409', url: '' });
      GitHubApiClient.prototype.createTree = async () => ({ sha: 'tree-409', url: '' });

      const branch = await GitHubWriteService.createBranchAndStageChangeset(cs409Id, testUserId);
      assert.strictEqual(branch.baseSha, 'indexed-safe-sha');
      assert.strictEqual(branch.metadata?.forkSyncStatus, 'conflict_fallback');
      assert.ok(String(branch.metadata?.forkSyncWarning || '').includes('409 Conflict'));

      // Now simulate drifted target file too -> must throw actionable 409 Fork sync conflict error
      GitHubApiClient.prototype.getFileContent = async () => ({
        name: 'a.ts',
        path: 'src/a.ts',
        sha: 'file-sha-drifted',
        size: 25,
        content: Buffer.from('export const a = 999; // conflicted').toString('base64'),
        encoding: 'base64',
      });

      await assert.rejects(
        () => GitHubWriteService.createBranchAndStageChangeset(cs409Id, testUserId),
        /Fork sync conflict \(409\)/i
      );
    } finally {
      Object.assign(GitHubApiClient.prototype, originals);
      await query(`DELETE FROM repositories WHERE id = $1`, [repo409Id]);
    }
  });
});
