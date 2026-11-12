import { query, ensureDatabaseSchema } from '../db/client';
import { createGitHubClient, GitTreeItem } from './githubClient';
import { CodeGeneratorService } from '../planner/codeGeneratorService';
import { CodeValidationService } from '../validation/codeValidationService';
import { parseGitHubUrl } from '../ingestion/githubIngestion';
import { ChangesetBranch, PullRequestRecord } from '@/types';

export class GitHubWriteService {
  /**
   * Creates a dedicated GitHub feature branch from the repository's default branch
   * and prepares/stages the approved changeset using GitHub's Git Data API.
   *
   * STRICT GUARANTEES:
   * 1. Never modifies default branch (main/master/etc.).
   * 2. Detects repository drift against originalContent; aborts if upstream has changed.
   * 3. Operates on the EXACT requested approved changeset version.
   * 4. Enforces validation model (allows passed and applicable skipped; blocks failed/error).
   * 5. Does not create or push a commit (reserved for Phase 4.2).
   */
  static async createBranchAndStageChangeset(
    changesetId: string,
    userId: string
  ): Promise<ChangesetBranch> {
    await ensureDatabaseSchema();

    if (!changesetId || !userId) {
      throw new Error('Changeset ID and authenticated User ID are required.');
    }

    // 1. Load exact changeset version
    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset) {
      throw new Error('Changeset not found.');
    }

    // 2. Verify changeset belongs strictly to user
    if (changeset.userId !== userId) {
      throw new Error('Unauthorized: Changeset belongs to another user.');
    }

    // 3. Verify changeset is approved
    if (changeset.status !== 'approved') {
      throw new Error(
        `Changeset must be approved before creating a GitHub branch (current status: '${changeset.status}').`
      );
    }

    // 4. Verify changeset has file changes
    if (!changeset.changes || changeset.changes.length === 0) {
      throw new Error('Changeset contains no file changes to apply.');
    }

    // 5. Verify validation readiness (respecting passed and applicable skipped)
    const latestValidation = await CodeValidationService.getLatestValidationForChangeset(changesetId);
    if (latestValidation) {
      const status = latestValidation.status;
      if (status === 'failed' || status === 'error') {
        throw new Error(
          `Validation ${status.toUpperCase()} for this changeset. All compiler, build, or test errors must be resolved before creating a GitHub branch.`
        );
      }
    }

    // 6. Retrieve target repository and verify it is GitHub-backed
    const repoRes = await query(
      `SELECT id, name, full_name, source_type, github_url, user_id
       FROM repositories
       WHERE id = $1`,
      [changeset.repositoryId]
    );

    if (repoRes.rows.length === 0) {
      throw new Error('Target repository not found in CodeGraph.');
    }

    const repoRow = repoRes.rows[0];

    if (repoRow.user_id !== userId) {
      throw new Error('Unauthorized: Target repository belongs to another user.');
    }

    if (repoRow.source_type !== 'github' || !repoRow.github_url) {
      throw new Error(
        'This repository is not linked to GitHub. Only GitHub-backed repositories support automatic branch creation.'
      );
    }

    // 7. Parse canonical owner/repo
    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const owner = parsedInfo.owner;
    const repo = parsedInfo.repo;

    // 8. Create authenticated GitHub API client
    const ghClient = await createGitHubClient(userId);

    // 9. Verify repository accessibility & write permissions
    const ghRepo = await ghClient.getRepository(owner, repo);
    if (ghRepo.permissions && !ghRepo.permissions.push && !ghRepo.permissions.admin) {
      throw new Error(
        `Your connected GitHub account does not have write (push) permission to repository '${owner}/${repo}'.`
      );
    }

    // 10. Fetch current default branch and commit SHA
    const defaultBranch = ghRepo.default_branch || 'main';
    const defaultRef = await ghClient.getRef(owner, repo, `heads/${defaultBranch}`);

    if (!defaultRef || !defaultRef.object?.sha) {
      throw new Error(
        `Could not retrieve latest commit SHA for default branch '${defaultBranch}' on '${owner}/${repo}'.`
      );
    }

    const baseSha = defaultRef.object.sha;

    // Retrieve base commit to access root tree SHA
    const baseCommit = await ghClient.getCommit(owner, repo, baseSha);
    const baseTreeSha = baseCommit.tree.sha;

    // 11. CRITICAL SAFETY CHECK: Detect Repository Drift
    // Ensure all target files still match the exact content used to generate the changeset
    for (const change of changeset.changes) {
      if (change.changeType === 'modify' || change.changeType === 'delete') {
        const currentGhFile = await ghClient.getFileContent(owner, repo, change.filePath, baseSha);

        if (!currentGhFile || typeof currentGhFile.content !== 'string') {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' does not exist on GitHub default branch '${defaultBranch}' (${baseSha.slice(0, 7)}). The repository has changed since this changeset was generated. Please regenerate the changeset before applying.`
          );
        }

        // Decode base64 content and normalize line endings for safe comparison
        const currentContent = Buffer.from(currentGhFile.content, 'base64').toString('utf8');
        const normCurrent = currentContent.replace(/\r\n/g, '\n').trim();
        const normExpected = (change.originalContent || '').replace(/\r\n/g, '\n').trim();

        if (normCurrent !== normExpected) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' has been modified on GitHub since changeset v${changeset.version} was generated. Upstream changes would be overwritten. Please regenerate the changeset before applying.`
          );
        }
      } else if (change.changeType === 'create') {
        const existingFile = await ghClient.getFileContent(owner, repo, change.filePath, baseSha);
        if (existingFile) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' already exists on GitHub default branch '${defaultBranch}'. Please regenerate the changeset before applying.`
          );
        }
      }
    }

    // 12. Determine sanitized, Git-safe branch name with idempotent suffixing
    const cleanPlanId = changeset.featurePlanId
      .replace(/^fp-/, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 16);
    const baseBranchName = `codegraph/feature-plan-${cleanPlanId}-v${changeset.version}`.toLowerCase();

    let targetBranchName = baseBranchName;
    const existingBranchRef = await ghClient.getRef(owner, repo, `heads/${targetBranchName}`);

    if (existingBranchRef) {
      // If branch already exists, check whether we already tracked it for this changeset
      const existingBranchDb = await query(
        `SELECT id, branch_name FROM changeset_branches WHERE changeset_id = $1 AND branch_name = $2`,
        [changesetId, targetBranchName]
      );

      if (existingBranchDb.rows.length === 0) {
        // Another branch with same name exists on GitHub -> create unique suffix
        const suffix = Date.now().toString().slice(-4);
        targetBranchName = `${baseBranchName}-${suffix}`;
      }
    }

    // 13. Create the new Git branch ref on GitHub (NEVER modifies default branch)
    const branchRefCheck = await ghClient.getRef(owner, repo, `heads/${targetBranchName}`);
    if (!branchRefCheck) {
      await ghClient.createRef(owner, repo, `refs/heads/${targetBranchName}`, baseSha);
    }

    // 14. Stage changeset changes using Git Data API (Blobs & Tree)
    // Note: PHASE 4.1 stops before commit creation; Phase 4.2 owns committing and updating refs
    const treeItems: GitTreeItem[] = [];

    for (const change of changeset.changes) {
      if (change.changeType === 'modify' || change.changeType === 'create') {
        const blobRes = await ghClient.createBlob(owner, repo, change.proposedContent, 'utf-8');
        treeItems.push({
          path: change.filePath,
          mode: '100644',
          type: 'blob',
          sha: blobRes.sha,
        });
      } else if (change.changeType === 'delete') {
        treeItems.push({
          path: change.filePath,
          mode: '100644',
          type: 'blob',
          sha: null, // Instructs GitHub Git Data API to delete the path in the new tree
        });
      }
    }

    // Create staged Git tree in GitHub repository
    const stagedTree = await ghClient.createTree(owner, repo, baseTreeSha, treeItems);
    const stagedTreeSha = stagedTree.sha;

    // 15. Persist branch metadata to database
    const upsertSql = `
      INSERT INTO changeset_branches (
        changeset_id,
        repository_id,
        user_id,
        github_repo_owner,
        github_repo_name,
        branch_name,
        base_branch,
        base_sha,
        staged_tree_sha,
        status,
        file_count,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staged', $10, $11, NOW())
      ON CONFLICT (changeset_id, branch_name) DO UPDATE SET
        base_sha = EXCLUDED.base_sha,
        staged_tree_sha = EXCLUDED.staged_tree_sha,
        status = EXCLUDED.status,
        file_count = EXCLUDED.file_count,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *;
    `;

    const branchMetadata = {
      featurePlanId: changeset.featurePlanId,
      changesetVersion: changeset.version,
      defaultBranch,
      baseSha,
      stagedTreeSha,
      treeItemsCount: treeItems.length,
    };

    const branchRes = await query(upsertSql, [
      changesetId,
      changeset.repositoryId,
      userId,
      owner,
      repo,
      targetBranchName,
      defaultBranch,
      baseSha,
      stagedTreeSha,
      changeset.changes.length,
      JSON.stringify(branchMetadata),
    ]);

    const row = branchRes.rows[0];

    return {
      id: row.id,
      changesetId: row.changeset_id,
      repositoryId: row.repository_id,
      userId: row.user_id,
      githubRepoOwner: row.github_repo_owner,
      githubRepoName: row.github_repo_name,
      branchName: row.branch_name,
      baseBranch: row.base_branch,
      baseSha: row.base_sha,
      stagedTreeSha: row.staged_tree_sha,
      status: row.status,
      fileCount: row.file_count,
      htmlUrl: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(row.branch_name)}`,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      commitSha: row.commit_sha || undefined,
      commitMessage: row.commit_message || undefined,
      committedAt: row.committed_at?.toISOString?.() || (row.committed_at ? new Date(row.committed_at).toISOString() : undefined),
      commitUrl: row.commit_sha
        ? `https://github.com/${owner}/${repo}/commit/${row.commit_sha}`
        : undefined,
      createdAt: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at?.toISOString?.() || new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Commits the approved changeset changes and pushes the commit to the feature branch.
   *
   * PHASE 4.2 GUARANTEES:
   * 1. Never commits to or modifies default branch.
   * 2. Verifies branch concurrency (aborts if branch moved unexpectedly).
   * 3. Re-checks upstream repository drift before committing.
   * 4. Creates ONE atomic commit via Git Data API.
   * 5. Updates feature branch ref (fast-forward push).
   * 6. Persists commit metadata.
   */
  static async commitAndPushChangeset(
    changesetId: string,
    userId: string,
    customCommitMessage?: string
  ): Promise<ChangesetBranch> {
    await ensureDatabaseSchema();

    if (!changesetId || !userId) {
      throw new Error('Changeset ID and authenticated User ID are required.');
    }

    // 1. Load exact changeset version
    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset) {
      throw new Error('Changeset not found.');
    }

    if (changeset.userId !== userId) {
      throw new Error('Unauthorized: Changeset belongs to another user.');
    }

    if (changeset.status !== 'approved') {
      throw new Error(
        `Changeset must be approved before committing to GitHub (current status: '${changeset.status}').`
      );
    }

    if (!changeset.changes || changeset.changes.length === 0) {
      throw new Error('Changeset contains no file changes to commit.');
    }

    // 2. Enforce validation readiness model
    const latestValidation = await CodeValidationService.getLatestValidationForChangeset(changesetId);
    if (latestValidation) {
      const status = latestValidation.status;
      if (status === 'failed' || status === 'error') {
        throw new Error(
          `Validation ${status.toUpperCase()} for this changeset. All compiler, build, or test errors must be resolved before committing.`
        );
      }
    }

    // 3. Retrieve target repository
    const repoRes = await query(
      `SELECT id, name, full_name, source_type, github_url, user_id
       FROM repositories
       WHERE id = $1`,
      [changeset.repositoryId]
    );

    if (repoRes.rows.length === 0) {
      throw new Error('Target repository not found in CodeGraph.');
    }

    const repoRow = repoRes.rows[0];
    if (repoRow.user_id !== userId) {
      throw new Error('Unauthorized: Target repository belongs to another user.');
    }

    if (repoRow.source_type !== 'github' || !repoRow.github_url) {
      throw new Error('This repository is not linked to GitHub.');
    }

    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const owner = parsedInfo.owner;
    const repo = parsedInfo.repo;

    // 4. Retrieve branch created in Phase 4.1
    const existingBranch = await this.getBranchForChangeset(changesetId, userId);
    if (!existingBranch) {
      throw new Error(
        'No feature branch has been created for this changeset yet. Please create a feature branch first.'
      );
    }

    // Idempotency: if already committed, return existing commit
    if (existingBranch.status === 'committed' && existingBranch.commitSha) {
      return existingBranch;
    }

    const ghClient = await createGitHubClient(userId);

    // 5. Verify feature branch still exists on GitHub
    const branchRef = await ghClient.getRef(owner, repo, `heads/${existingBranch.branchName}`);
    if (!branchRef) {
      throw new Error(
        `Feature branch '${existingBranch.branchName}' no longer exists on GitHub. Please re-create the branch.`
      );
    }

    const currentBranchSha = branchRef.object.sha;

    // 6. Branch Concurrency Protection
    // Ensure the branch has not moved unexpectedly since Phase 4.1
    if (currentBranchSha !== existingBranch.baseSha && currentBranchSha !== existingBranch.commitSha) {
      throw new Error(
        `GitHub branch '${existingBranch.branchName}' has changed unexpectedly since CodeGraph prepared the changes. Refresh the branch state before committing.`
      );
    }

    // 7. Re-check Repository Drift before writing final commit
    for (const change of changeset.changes) {
      if (change.changeType === 'modify' || change.changeType === 'delete') {
        const currentGhFile = await ghClient.getFileContent(owner, repo, change.filePath, existingBranch.baseSha);

        if (!currentGhFile || typeof currentGhFile.content !== 'string') {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' does not exist on GitHub. Upstream changes have occurred since changeset v${changeset.version} was prepared. Please regenerate the changeset before committing.`
          );
        }

        const currentContent = Buffer.from(currentGhFile.content, 'base64').toString('utf8');
        const normCurrent = currentContent.replace(/\r\n/g, '\n').trim();
        const normExpected = (change.originalContent || '').replace(/\r\n/g, '\n').trim();

        if (normCurrent !== normExpected) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' has been modified on GitHub since changeset v${changeset.version} was prepared. Please regenerate the changeset before committing.`
          );
        }
      } else if (change.changeType === 'create') {
        const existingFile = await ghClient.getFileContent(owner, repo, change.filePath, existingBranch.baseSha);
        if (existingFile) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' already exists on GitHub. Please regenerate the changeset before committing.`
          );
        }
      }
    }

    // 8. Determine Git Tree SHA (use stagedTreeSha or construct tree items)
    let treeSha = existingBranch.stagedTreeSha;

    if (!treeSha) {
      const baseCommit = await ghClient.getCommit(owner, repo, existingBranch.baseSha);
      const treeItems: GitTreeItem[] = [];

      for (const change of changeset.changes) {
        if (change.changeType === 'modify' || change.changeType === 'create') {
          const blobRes = await ghClient.createBlob(owner, repo, change.proposedContent, 'utf-8');
          treeItems.push({
            path: change.filePath,
            mode: '100644',
            type: 'blob',
            sha: blobRes.sha,
          });
        } else if (change.changeType === 'delete') {
          treeItems.push({
            path: change.filePath,
            mode: '100644',
            type: 'blob',
            sha: null,
          });
        }
      }

      const createdTree = await ghClient.createTree(owner, repo, baseCommit.tree.sha, treeItems);
      treeSha = createdTree.sha;
    }

    // 9. Generate structured, professional commit message
    const filesSummary = changeset.changes
      .map((c) => `- ${c.changeType.toUpperCase()}: ${c.filePath}`)
      .join('\n');

    const defaultCommitMessage = `[CodeGraph] ${changeset.summary} (v${changeset.version})\n\nFeature Plan: ${changeset.featurePlanId}\nFiles Changed:\n${filesSummary}`;
    const commitMessage = (customCommitMessage && customCommitMessage.trim()) || defaultCommitMessage;

    // 10. Create ONE commit via Git Data API
    const newCommit = await ghClient.createCommit(owner, repo, commitMessage, treeSha, [existingBranch.baseSha]);
    const newCommitSha = newCommit.sha;

    // 11. Advance feature branch ref (fast-forward push, never modifies default branch)
    await ghClient.updateRef(owner, repo, `heads/${existingBranch.branchName}`, newCommitSha, false);

    // 12. Persist commit metadata to database
    const updateSql = `
      UPDATE changeset_branches
      SET commit_sha = $1,
          commit_message = $2,
          committed_at = NOW(),
          status = 'committed',
          updated_at = NOW()
      WHERE changeset_id = $3 AND branch_name = $4
      RETURNING *;
    `;

    const updatedRes = await query(updateSql, [
      newCommitSha,
      commitMessage,
      changesetId,
      existingBranch.branchName,
    ]);

    const row = updatedRes.rows[0];

    return {
      id: row.id,
      changesetId: row.changeset_id,
      repositoryId: row.repository_id,
      userId: row.user_id,
      githubRepoOwner: row.github_repo_owner,
      githubRepoName: row.github_repo_name,
      branchName: row.branch_name,
      baseBranch: row.base_branch,
      baseSha: row.base_sha,
      stagedTreeSha: row.staged_tree_sha,
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      committedAt: row.committed_at?.toISOString?.() || new Date(row.committed_at).toISOString(),
      status: 'committed',
      fileCount: row.file_count,
      htmlUrl: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(row.branch_name)}`,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at?.toISOString?.() || new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Retrieves the latest branch record for a changeset if already created.
   */
  static async getBranchForChangeset(
    changesetId: string,
    userId?: string
  ): Promise<ChangesetBranch | null> {
    await ensureDatabaseSchema();

    if (!changesetId) return null;

    const res = await query(
      `SELECT id, changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
              branch_name, base_branch, base_sha, staged_tree_sha, commit_sha, commit_message,
              committed_at, status, file_count, metadata, created_at, updated_at
       FROM changeset_branches
       WHERE changeset_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [changesetId]
    );

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    if (userId && row.user_id !== userId) {
      return null;
    }

    return {
      id: row.id,
      changesetId: row.changeset_id,
      repositoryId: row.repository_id,
      userId: row.user_id,
      githubRepoOwner: row.github_repo_owner,
      githubRepoName: row.github_repo_name,
      branchName: row.branch_name,
      baseBranch: row.base_branch,
      baseSha: row.base_sha,
      stagedTreeSha: row.staged_tree_sha,
      commitSha: row.commit_sha || undefined,
      commitMessage: row.commit_message || undefined,
      committedAt: row.committed_at?.toISOString?.() || (row.committed_at ? new Date(row.committed_at).toISOString() : undefined),
      status: row.status,
      fileCount: row.file_count,
      htmlUrl: `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/tree/${encodeURIComponent(
        row.branch_name
      )}`,
      commitUrl: row.commit_sha
        ? `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/commit/${row.commit_sha}`
        : undefined,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      createdAt: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString(),
      updatedAt: row.updated_at?.toISOString?.() || new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Creates a GitHub Pull Request from the committed feature branch to the repository's default branch.
   *
   * PHASE 4.3 GUARANTEES:
   * 1. Requires approved changeset with committed feature branch.
   * 2. Never creates PR from or targets an improper branch (head: feature branch, base: default branch).
   * 3. Idempotent: checks local database and GitHub upstream before creating duplicate PRs.
   * 4. Truthful deterministic title and markdown body (reflecting actual validation results).
   * 5. Persists PR metadata to `pull_requests` table and returns safe PullRequestRecord.
   */
  static async createPullRequestForChangeset(
    changesetId: string,
    userId: string,
    customTitle?: string,
    customBody?: string
  ): Promise<PullRequestRecord> {
    await ensureDatabaseSchema();

    if (!changesetId || !userId) {
      throw new Error('Changeset ID and authenticated User ID are required.');
    }

    // 1. Check idempotency: Return existing PR if already recorded
    const existingPr = await this.getPullRequestForChangeset(changesetId, userId);
    if (existingPr) {
      return existingPr;
    }

    // 2. Load exact changeset
    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset) {
      throw new Error('Changeset not found.');
    }

    if (changeset.userId !== userId) {
      throw new Error('Unauthorized: Changeset belongs to another user.');
    }

    if (changeset.status !== 'approved') {
      throw new Error(
        `Changeset must be approved before creating a Pull Request (current status: '${changeset.status}').`
      );
    }

    // 3. Enforce validation readiness model
    const latestValidation = await CodeValidationService.getLatestValidationForChangeset(changesetId);
    if (latestValidation) {
      const status = latestValidation.status;
      if (status === 'failed' || status === 'error') {
        throw new Error(
          `Validation ${status.toUpperCase()} for this changeset. All compiler, build, or test errors must be resolved before creating a Pull Request.`
        );
      }
    }

    // 4. Retrieve target repository
    const repoRes = await query(
      `SELECT id, name, full_name, source_type, github_url, user_id
       FROM repositories
       WHERE id = $1`,
      [changeset.repositoryId]
    );

    if (repoRes.rows.length === 0) {
      throw new Error('Target repository not found in CodeGraph.');
    }

    const repoRow = repoRes.rows[0];
    if (repoRow.user_id !== userId) {
      throw new Error('Unauthorized: Target repository belongs to another user.');
    }

    if (repoRow.source_type !== 'github' || !repoRow.github_url) {
      throw new Error('This repository is not linked to GitHub.');
    }

    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const owner = parsedInfo.owner;
    const repo = parsedInfo.repo;

    // 5. Retrieve feature branch created in Phase 4.1 & committed in Phase 4.2
    const branch = await this.getBranchForChangeset(changesetId, userId);
    if (!branch) {
      throw new Error(
        'No feature branch has been created for this changeset. Please create a branch and commit changes first.'
      );
    }

    if (!branch.commitSha) {
      throw new Error(
        'Changes have not been committed to the GitHub feature branch yet. Please commit changes before creating a Pull Request.'
      );
    }

    const ghClient = await createGitHubClient(userId);

    // 6. Verify feature branch still exists on GitHub and contains the expected commit
    const branchRef = await ghClient.getRef(owner, repo, `heads/${branch.branchName}`);
    if (!branchRef) {
      throw new Error(
        `Feature branch '${branch.branchName}' no longer exists on GitHub. Please recreate and commit the branch.`
      );
    }

    if (branchRef.object.sha !== branch.commitSha) {
      throw new Error(
        `Feature branch head on GitHub (${branchRef.object.sha.slice(0, 7)}) does not match the CodeGraph commit (${branch.commitSha.slice(0, 7)}). Aborting Pull Request creation to protect repository state.`
      );
    }

    // 7. Check upstream idempotency: Has a PR already been created on GitHub?
    const existingGhPrs = await ghClient.listPullRequests(
      owner,
      repo,
      `${owner}:${branch.branchName}`,
      branch.baseBranch,
      'all'
    );

    if (existingGhPrs.length > 0) {
      const match = existingGhPrs[0];
      const matchStatus = match.state === 'closed' ? (match.merged ? 'merged' : 'closed') : 'open';

      const insertSql = `
        INSERT INTO pull_requests (
          changeset_id,
          repository_id,
          user_id,
          github_repo_owner,
          github_repo_name,
          github_pr_number,
          github_pr_url,
          github_pr_api_url,
          branch_name,
          base_branch,
          commit_sha,
          title,
          body,
          status,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (changeset_id) DO UPDATE SET
          github_pr_number = EXCLUDED.github_pr_number,
          github_pr_url = EXCLUDED.github_pr_url,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING *;
      `;

      const res = await query(insertSql, [
        changesetId,
        changeset.repositoryId,
        userId,
        owner,
        repo,
        match.number,
        match.html_url,
        match.url,
        branch.branchName,
        branch.baseBranch,
        branch.commitSha,
        match.title,
        match.body || '',
        matchStatus,
      ]);

      await query(
        `UPDATE changeset_branches SET status = 'pr_created', updated_at = NOW() WHERE changeset_id = $1`,
        [changesetId]
      );

      const r = res.rows[0];
      return {
        id: r.id,
        changesetId: r.changeset_id,
        repositoryId: r.repository_id,
        userId: r.user_id,
        githubRepoOwner: r.github_repo_owner,
        githubRepoName: r.github_repo_name,
        githubPrNumber: r.github_pr_number,
        githubPrUrl: r.github_pr_url,
        githubPrApiUrl: r.github_pr_api_url,
        branchName: r.branch_name,
        baseBranch: r.base_branch,
        commitSha: r.commit_sha,
        title: r.title,
        body: r.body,
        status: r.status,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
        createdAt: r.created_at?.toISOString?.() || new Date(r.created_at).toISOString(),
        updatedAt: r.updated_at?.toISOString?.() || new Date(r.updated_at).toISOString(),
      };
    }

    // 8. Generate deterministic PR Title
    let fpFeatureRequest: string | undefined;
    try {
      const fpRes = await query(
        `SELECT feature_request FROM feature_plans WHERE id = $1`,
        [changeset.featurePlanId]
      );
      if (fpRes.rows.length > 0) {
        fpFeatureRequest = fpRes.rows[0].feature_request;
      }
    } catch {
      // Passive
    }

    const defaultTitle = fpFeatureRequest
      ? `[CodeGraph] ${fpFeatureRequest.slice(0, 80)}`
      : `[CodeGraph] ${changeset.summary.slice(0, 80)}`;
    const title = (customTitle && customTitle.trim()) || defaultTitle;

    // 9. Generate deterministic markdown PR Body
    const filesSummary = changeset.changes
      .map((c) => `- **${c.changeType.toUpperCase()}** \`${c.filePath}\``)
      .join('\n');

    let validationSection = '- **Validation**: Not executed';
    if (latestValidation) {
      const checksText = latestValidation.checks
        ?.map((chk) => {
          const formattedStatus = chk.status === 'passed' ? '✅ Passed' : chk.status === 'skipped' ? '⚠️ Skipped' : '❌ Failed';
          return `- **${chk.name}**: ${formattedStatus}${chk.message ? ` (${chk.message})` : ''}`;
        })
        .join('\n');
      validationSection = checksText || `- **Overall Status**: ${latestValidation.status.toUpperCase()}`;
    }

    const defaultBody = `## Summary
${changeset.summary || fpFeatureRequest || 'Code changes implemented by CodeGraph.'}

## Changes
${filesSummary}

## Validation Summary
${validationSection}

---
*Generated with [CodeGraph](https://github.com/) • Changeset v${changeset.version} • Commit \`${branch.commitSha.slice(0, 7)}\`*`;

    const body = (customBody && customBody.trim()) || defaultBody;

    // 10. Call GitHub Pull Request API
    const newPr = await ghClient.createPullRequest(
      owner,
      repo,
      title,
      branch.branchName,
      branch.baseBranch,
      body
    );

    const prStatus = newPr.state === 'closed' ? (newPr.merged ? 'merged' : 'closed') : 'open';

    // 11. Persist PR record to database
    const insertSql = `
      INSERT INTO pull_requests (
        changeset_id,
        repository_id,
        user_id,
        github_repo_owner,
        github_repo_name,
        github_pr_number,
        github_pr_url,
        github_pr_api_url,
        branch_name,
        base_branch,
        commit_sha,
        title,
        body,
        status,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      ON CONFLICT (changeset_id) DO UPDATE SET
        github_pr_number = EXCLUDED.github_pr_number,
        github_pr_url = EXCLUDED.github_pr_url,
        status = EXCLUDED.status,
        updated_at = NOW()
      RETURNING *;
    `;

    const prRes = await query(insertSql, [
      changesetId,
      changeset.repositoryId,
      userId,
      owner,
      repo,
      newPr.number,
      newPr.html_url,
      newPr.url,
      branch.branchName,
      branch.baseBranch,
      branch.commitSha,
      newPr.title,
      newPr.body || body,
      prStatus,
    ]);

    // Update changeset_branches status to 'pr_created'
    await query(
      `UPDATE changeset_branches SET status = 'pr_created', updated_at = NOW() WHERE changeset_id = $1`,
      [changesetId]
    );

    const r = prRes.rows[0];

    return {
      id: r.id,
      changesetId: r.changeset_id,
      repositoryId: r.repository_id,
      userId: r.user_id,
      githubRepoOwner: r.github_repo_owner,
      githubRepoName: r.github_repo_name,
      githubPrNumber: r.github_pr_number,
      githubPrUrl: r.github_pr_url,
      githubPrApiUrl: r.github_pr_api_url,
      branchName: r.branch_name,
      baseBranch: r.base_branch,
      commitSha: r.commit_sha,
      title: r.title,
      body: r.body,
      status: r.status,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      createdAt: r.created_at?.toISOString?.() || new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at?.toISOString?.() || new Date(r.updated_at).toISOString(),
    };
  }

  /**
   * Retrieves the Pull Request record for a changeset if already created.
   */
  static async getPullRequestForChangeset(
    changesetId: string,
    userId?: string
  ): Promise<PullRequestRecord | null> {
    await ensureDatabaseSchema();

    if (!changesetId) return null;

    const res = await query(
      `SELECT id, changeset_id, repository_id, user_id, github_repo_owner, github_repo_name,
              github_pr_number, github_pr_url, github_pr_api_url, branch_name, base_branch,
              commit_sha, title, body, status, metadata, created_at, updated_at
       FROM pull_requests
       WHERE changeset_id = $1
       LIMIT 1`,
      [changesetId]
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];

    if (userId && r.user_id !== userId) {
      return null;
    }

    return {
      id: r.id,
      changesetId: r.changeset_id,
      repositoryId: r.repository_id,
      userId: r.user_id,
      githubRepoOwner: r.github_repo_owner,
      githubRepoName: r.github_repo_name,
      githubPrNumber: r.github_pr_number,
      githubPrUrl: r.github_pr_url,
      githubPrApiUrl: r.github_pr_api_url,
      branchName: r.branch_name,
      baseBranch: r.base_branch,
      commitSha: r.commit_sha,
      title: r.title,
      body: r.body,
      status: r.status,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      createdAt: r.created_at?.toISOString?.() || new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at?.toISOString?.() || new Date(r.updated_at).toISOString(),
    };
  }
}

