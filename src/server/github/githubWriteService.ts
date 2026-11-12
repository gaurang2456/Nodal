import { query, ensureDatabaseSchema } from '../db/client';
import { createGitHubClient, GitHubApiClient, GitTreeItem } from './githubClient';
import { CodeGeneratorService } from '../planner/codeGeneratorService';
import { CodeValidationService } from '../validation/codeValidationService';
import { parseGitHubUrl } from '../ingestion/githubIngestion';
import { ChangesetBranch, PullRequestRecord } from '@/types';

const PROTECTED_BRANCH_NAMES = new Set([
  'main',
  'master',
  'develop',
  'development',
  'production',
  'prod',
  'staging',
  'release',
]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubWriteService {
  /**
   * Code-level safety guard preventing any write to default or protected branches.
   */
  static assertSafeTargetBranch(
    branchName: string,
    defaultBranch: string,
    isProtectedBranch: boolean = false,
    options?: { allowLegacyPrefix?: boolean }
  ): void {
    const clean = (branchName || '').trim();
    if (!clean) {
      throw new Error('Safety guard blocked GitHub write: branch name cannot be empty.');
    }

    if (
      clean.includes('..') ||
      /\s/.test(clean) ||
      clean.startsWith('/') ||
      clean.endsWith('/') ||
      clean.endsWith('.lock')
    ) {
      throw new Error(`Safety guard blocked GitHub write: invalid branch name '${branchName}'.`);
    }

    const lower = clean.toLowerCase();
    const defaultLower = (defaultBranch || 'main').trim().toLowerCase();

    if (lower === defaultLower || PROTECTED_BRANCH_NAMES.has(lower) || isProtectedBranch) {
      throw new Error(
        `Safety guard blocked GitHub write: refusing to write to default or protected branch '${clean}'.`
      );
    }

    const hasValidPrefix =
      lower.startsWith('nodal/') ||
      (options?.allowLegacyPrefix === true && lower.startsWith('codegraph/'));

    if (!hasValidPrefix) {
      throw new Error(
        `Safety guard blocked GitHub write: target branch '${clean}' must be under the 'nodal/' namespace.`
      );
    }
  }

  /**
   * Generates a deterministic, Git-safe branch name:
   * - Issue-linked: nodal/<issue-number>-<short-slug>
   * - Legacy / non-issue plan: nodal/feature-plan-<id>-v<version>
   */
  static buildBranchName(params: {
    featurePlanId: string;
    changesetVersion: number;
    issueNumber?: number | null;
    issueTitle?: string | null;
    featureRequest?: string | null;
  }): string {
    if (params.issueNumber && Number.isFinite(params.issueNumber)) {
      const sourceText = params.issueTitle || params.featureRequest || 'fix';
      const slug = sourceText
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
      return `nodal/${params.issueNumber}-${slug || 'fix'}`;
    }

    const cleanPlanId = params.featurePlanId
      .replace(/^fp-/, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 16);
    return `nodal/feature-plan-${cleanPlanId}-v${params.changesetVersion}`.toLowerCase();
  }

  /**
   * Resolves a unique branch name in the target host repository that does not collide with
   * an unrelated existing branch.
   */
  private static async resolveUniqueBranchName(
    ghClient: GitHubApiClient,
    hostOwner: string,
    hostRepo: string,
    changesetId: string,
    baseBranchName: string,
    defaultBranch: string
  ): Promise<string> {
    this.assertSafeTargetBranch(baseBranchName, defaultBranch);

    const existingRef = await ghClient.getRef(hostOwner, hostRepo, `heads/${baseBranchName}`);
    if (!existingRef) {
      return baseBranchName;
    }

    const existingBranchDb = await query(
      `SELECT id FROM changeset_branches WHERE changeset_id = $1 AND branch_name = $2`,
      [changesetId, baseBranchName]
    );
    if (existingBranchDb.rows.length > 0) {
      return baseBranchName;
    }

    for (let attempt = 2; attempt <= 6; attempt++) {
      const candidate = `${baseBranchName}-${attempt}`;
      const refCheck = await ghClient.getRef(hostOwner, hostRepo, `heads/${candidate}`);
      if (!refCheck) {
        return candidate;
      }
    }

    const suffix = Date.now().toString().slice(-4);
    return `${baseBranchName}-${suffix}`;
  }

  /**
   * Verifies that none of the files modified/deleted/created by the changeset have drifted on GitHub
   * relative to the originalContent stored when the changeset was generated.
   */
  private static async assertNoFileDrift(
    ghClient: GitHubApiClient,
    owner: string,
    repo: string,
    baseBranchLabel: string,
    baseSha: string,
    changes: Array<{
      filePath: string;
      changeType: 'modify' | 'create' | 'delete';
      originalContent?: string | null;
    }>,
    changesetVersion: number,
    phaseLabel: 'applying' | 'committing' = 'applying'
  ): Promise<void> {
    for (const change of changes) {
      if (change.changeType === 'modify' || change.changeType === 'delete') {
        const currentGhFile = await ghClient.getFileContent(owner, repo, change.filePath, baseSha);

        if (!currentGhFile || typeof currentGhFile.content !== 'string') {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' does not exist on GitHub branch '${baseBranchLabel}' (${baseSha.slice(0, 7)}). The repository has changed since this changeset was generated. Please regenerate the changeset before ${phaseLabel}.`
          );
        }

        const currentContent = Buffer.from(currentGhFile.content, 'base64').toString('utf8');
        const normCurrent = currentContent.replace(/\r\n/g, '\n').trim();
        const normExpected = (change.originalContent || '').replace(/\r\n/g, '\n').trim();

        if (normCurrent !== normExpected) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' has been modified on GitHub since changeset v${changesetVersion} was generated. Upstream changes would be overwritten. Please regenerate the changeset before ${phaseLabel}.`
          );
        }
      } else if (change.changeType === 'create') {
        const existingFile = await ghClient.getFileContent(owner, repo, change.filePath, baseSha);
        if (existingFile) {
          throw new Error(
            `Repository drift detected: File '${change.filePath}' already exists on GitHub branch '${baseBranchLabel}'. Please regenerate the changeset before ${phaseLabel}.`
          );
        }
      }
    }
  }

  /**
   * Creates a dedicated GitHub feature branch (in upstream repo when user has push access,
   * or in user's fork when contributor lacks push access) and stages the approved changeset.
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

    // 6. Retrieve target repository + feature plan issue metadata
    const repoRes = await query(
      `SELECT id, name, full_name, source_type, github_url, branch, indexed_commit_sha, user_id
       FROM repositories
       WHERE id = $1`,
      [changeset.repositoryId]
    );

    if (repoRes.rows.length === 0) {
      throw new Error('Target repository not found in Nodal.');
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

    let planMeta: {
      issueNumber?: number | null;
      issueTitle?: string | null;
      featureRequest?: string | null;
    } = {};
    try {
      const fpRes = await query(
        `SELECT issue_number, issue_title, feature_request FROM feature_plans WHERE id = $1`,
        [changeset.featurePlanId]
      );
      if (fpRes.rows.length > 0) {
        planMeta = {
          issueNumber: fpRes.rows[0].issue_number,
          issueTitle: fpRes.rows[0].issue_title,
          featureRequest: fpRes.rows[0].feature_request,
        };
      }
    } catch {
      // Passive metadata lookup
    }

    // 7. Parse canonical upstream owner/repo
    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const upstreamOwner = parsedInfo.owner;
    const upstreamRepoName = parsedInfo.repo;

    // 8. Create authenticated GitHub API client
    const ghClient = await createGitHubClient(userId);

    // 9. Inspect upstream repository & determine direct push vs contributor fork workflow
    const ghUpstreamRepo = await ghClient.getRepository(upstreamOwner, upstreamRepoName);
    const defaultBranch = ghUpstreamRepo.default_branch || repoRow.branch || 'main';

    const hasPushAccess = Boolean(
      ghUpstreamRepo.permissions?.push ||
        ghUpstreamRepo.permissions?.admin ||
        ghUpstreamRepo.permissions?.maintain
    );

    const upstreamDefaultRef = await ghClient.getRef(
      upstreamOwner,
      upstreamRepoName,
      `heads/${defaultBranch}`
    );

    if (!upstreamDefaultRef || !upstreamDefaultRef.object?.sha) {
      throw new Error(
        `Could not retrieve latest commit SHA for default branch '${defaultBranch}' on '${upstreamOwner}/${upstreamRepoName}'.`
      );
    }

    const upstreamHeadSha = upstreamDefaultRef.object.sha;
    const indexedCommitSha: string | null = repoRow.indexed_commit_sha || null;
    const upstreamMovedWarning =
      indexedCommitSha && indexedCommitSha !== upstreamHeadSha
        ? `Upstream '${upstreamOwner}/${upstreamRepoName}:${defaultBranch}' moved since indexing (indexed at ${indexedCommitSha.slice(
            0,
            7
          )}, live HEAD is ${upstreamHeadSha.slice(0, 7)}).`
        : null;

    const baseBranchName = this.buildBranchName({
      featurePlanId: changeset.featurePlanId,
      changesetVersion: changeset.version,
      issueNumber: planMeta.issueNumber,
      issueTitle: planMeta.issueTitle,
      featureRequest: planMeta.featureRequest,
    });

    let targetHostOwner = upstreamOwner;
    let targetHostRepo = upstreamRepoName;
    let isFork = false;
    let baseSha = upstreamHeadSha;
    let targetBranchName = baseBranchName;
    let forkSyncStatus: 'not_needed' | 'synced' | 'conflict_fallback' | null = null;
    let forkSyncWarning: string | null = null;

    if (hasPushAccess) {
      // Direct branch on upstream repository
      targetBranchName = await this.resolveUniqueBranchName(
        ghClient,
        targetHostOwner,
        targetHostRepo,
        changesetId,
        baseBranchName,
        defaultBranch
      );

      const branchProtection = await ghClient.getBranchInfo(
        targetHostOwner,
        targetHostRepo,
        targetBranchName
      );
      this.assertSafeTargetBranch(
        targetBranchName,
        defaultBranch,
        Boolean(branchProtection?.protected)
      );

      await this.assertNoFileDrift(
        ghClient,
        targetHostOwner,
        targetHostRepo,
        defaultBranch,
        baseSha,
        changeset.changes,
        changeset.version,
        'applying'
      );

      const branchRefCheck = await ghClient.getRef(
        targetHostOwner,
        targetHostRepo,
        `heads/${targetBranchName}`
      );
      if (!branchRefCheck) {
        await ghClient.createRef(
          targetHostOwner,
          targetHostRepo,
          `refs/heads/${targetBranchName}`,
          baseSha
        );
      }
    } else {
      // Contributor fork-first flow
      isFork = true;
      const ghUser = await ghClient.getUser();
      const forkDetails = await ghClient.createFork(upstreamOwner, upstreamRepoName);
      targetHostOwner = forkDetails.full_name?.split('/')?.[0] || ghUser.login;
      targetHostRepo = forkDetails.name || upstreamRepoName;

      // Poll until fork ref is ready (GitHub creates forks asynchronously)
      let forkDefaultRef: { ref: string; object: { sha: string; type: string } } | null = null;
      const maxPollAttempts = 8;
      for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
        forkDefaultRef = await ghClient.getRef(
          targetHostOwner,
          targetHostRepo,
          `heads/${defaultBranch}`
        );
        if (forkDefaultRef?.object?.sha) {
          break;
        }
        if (attempt < maxPollAttempts) {
          await sleep(Math.min(250 * attempt, 1500));
        }
      }

      if (!forkDefaultRef?.object?.sha) {
        throw new Error(
          `Your fork '${targetHostOwner}/${targetHostRepo}' is still initializing on GitHub. Please retry in a few seconds.`
        );
      }

      targetBranchName = await this.resolveUniqueBranchName(
        ghClient,
        targetHostOwner,
        targetHostRepo,
        changesetId,
        baseBranchName,
        defaultBranch
      );

      this.assertSafeTargetBranch(targetBranchName, defaultBranch);

      // IMPORTANT: Try branching from upstream commit SHA BEFORE calling merge-upstream!
      let branched = false;
      try {
        await ghClient.createRef(
          targetHostOwner,
          targetHostRepo,
          `refs/heads/${targetBranchName}`,
          upstreamHeadSha
        );
        baseSha = upstreamHeadSha;
        forkSyncStatus = 'not_needed';
        branched = true;
      } catch {
        // Fork does not have upstreamHeadSha yet -> try syncing fork with upstream
        const syncResult = await ghClient.syncForkUpstream(
          targetHostOwner,
          targetHostRepo,
          defaultBranch
        );

        if (syncResult.ok) {
          await ghClient.createRef(
            targetHostOwner,
            targetHostRepo,
            `refs/heads/${targetBranchName}`,
            upstreamHeadSha
          );
          baseSha = upstreamHeadSha;
          forkSyncStatus = 'synced';
          branched = true;
        } else if (syncResult.status === 409) {
          // Graceful handling for merge-upstream 409 conflict:
          // Attempt non-conflicting base SHA (indexed commit or fork default branch) if target files match
          const candidateShas = Array.from(
            new Set([indexedCommitSha, forkDefaultRef.object.sha].filter((s): s is string => Boolean(s)))
          );

          let conflictResolved = false;
          for (const candidateSha of candidateShas) {
            try {
              await this.assertNoFileDrift(
                ghClient,
                targetHostOwner,
                targetHostRepo,
                defaultBranch,
                candidateSha,
                changeset.changes,
                changeset.version,
                'applying'
              );
              await ghClient.createRef(
                targetHostOwner,
                targetHostRepo,
                `refs/heads/${targetBranchName}`,
                candidateSha
              );
              baseSha = candidateSha;
              forkSyncStatus = 'conflict_fallback';
              forkSyncWarning = `Your fork's '${defaultBranch}' branch diverged from '${upstreamOwner}/${upstreamRepoName}' (merge-upstream returned 409 Conflict). Branched from compatible commit ${candidateSha.slice(
                0,
                7
              )}; check for upstream merge conflicts after opening the PR.`;
              conflictResolved = true;
              branched = true;
              break;
            } catch {
              // Try next candidate SHA or fail gracefully below
            }
          }

          if (!conflictResolved) {
            throw new Error(
              `Fork sync conflict (409): Your fork '${targetHostOwner}/${targetHostRepo}:${defaultBranch}' has diverged from '${upstreamOwner}/${upstreamRepoName}:${defaultBranch}' on files touched by this changeset. Please sync or reset '${defaultBranch}' on your fork and try again.`
            );
          }
        } else {
          throw new Error(
            `Could not sync fork '${targetHostOwner}/${targetHostRepo}' with upstream (${syncResult.status}): ${syncResult.message || 'Sync failed.'}`
          );
        }
      }

      if (branched) {
        await this.assertNoFileDrift(
          ghClient,
          targetHostOwner,
          targetHostRepo,
          defaultBranch,
          baseSha,
          changeset.changes,
          changeset.version,
          'applying'
        );
      }
    }

    // Retrieve base commit to access root tree SHA on host repo
    const baseCommit = await ghClient.getCommit(targetHostOwner, targetHostRepo, baseSha);
    const baseTreeSha = baseCommit.tree.sha;

    // Stage changeset changes using Git Data API (Blobs & Tree)
    const treeItems: GitTreeItem[] = [];

    for (const change of changeset.changes) {
      if (change.changeType === 'modify' || change.changeType === 'create') {
        const blobRes = await ghClient.createBlob(
          targetHostOwner,
          targetHostRepo,
          change.proposedContent,
          'utf-8'
        );
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

    // Create staged Git tree in target host repository
    const stagedTree = await ghClient.createTree(targetHostOwner, targetHostRepo, baseTreeSha, treeItems);
    const stagedTreeSha = stagedTree.sha;

    // Persist branch metadata to database
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
        github_repo_owner = EXCLUDED.github_repo_owner,
        github_repo_name = EXCLUDED.github_repo_name,
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
      isFork,
      upstreamOwner,
      upstreamRepo: upstreamRepoName,
      upstreamHeadSha,
      indexedCommitSha,
      upstreamMovedWarning,
      forkSyncStatus,
      forkSyncWarning,
    };

    const branchRes = await query(upsertSql, [
      changesetId,
      changeset.repositoryId,
      userId,
      targetHostOwner,
      targetHostRepo,
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
      htmlUrl: `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/tree/${encodeURIComponent(row.branch_name)}`,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      commitSha: row.commit_sha || undefined,
      commitMessage: row.commit_message || undefined,
      committedAt: row.committed_at?.toISOString?.() || (row.committed_at ? new Date(row.committed_at).toISOString() : undefined),
      commitUrl: row.commit_sha
        ? `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/commit/${row.commit_sha}`
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
      throw new Error('Target repository not found in Nodal.');
    }

    const repoRow = repoRes.rows[0];
    if (repoRow.user_id !== userId) {
      throw new Error('Unauthorized: Target repository belongs to another user.');
    }

    if (repoRow.source_type !== 'github' || !repoRow.github_url) {
      throw new Error('This repository is not linked to GitHub.');
    }

    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const upstreamOwner = parsedInfo.owner;
    const upstreamRepo = parsedInfo.repo;

    // 4. Retrieve branch created in Phase 4.1 (either direct upstream repo or contributor fork)
    const existingBranch = await this.getBranchForChangeset(changesetId, userId);
    if (!existingBranch) {
      throw new Error(
        'No feature branch has been created for this changeset yet. Please create a feature branch first.'
      );
    }

    this.assertSafeTargetBranch(existingBranch.branchName, existingBranch.baseBranch, false, {
      allowLegacyPrefix: true,
    });

    const hostOwner = existingBranch.githubRepoOwner || upstreamOwner;
    const hostRepo = existingBranch.githubRepoName || upstreamRepo;

    // Idempotency: if already committed, return existing commit
    if (existingBranch.status === 'committed' && existingBranch.commitSha) {
      return existingBranch;
    }

    const ghClient = await createGitHubClient(userId);

    // 5. Verify feature branch still exists on GitHub (in upstream or fork)
    const branchRef = await ghClient.getRef(hostOwner, hostRepo, `heads/${existingBranch.branchName}`);
    if (!branchRef) {
      throw new Error(
        `Feature branch '${existingBranch.branchName}' no longer exists on GitHub (${hostOwner}/${hostRepo}). Please re-create the branch.`
      );
    }

    const currentBranchSha = branchRef.object.sha;

    // 6. Branch Concurrency Protection
    // Ensure the branch has not moved unexpectedly since Phase 4.1
    if (currentBranchSha !== existingBranch.baseSha && currentBranchSha !== existingBranch.commitSha) {
      throw new Error(
        `GitHub branch '${existingBranch.branchName}' has changed unexpectedly since Nodal prepared the changes. Refresh the branch state before committing.`
      );
    }

    // 7. Re-check Repository Drift before writing final commit
    await this.assertNoFileDrift(
      ghClient,
      hostOwner,
      hostRepo,
      existingBranch.baseBranch,
      existingBranch.baseSha,
      changeset.changes,
      changeset.version,
      'committing'
    );

    // 8. Determine Git Tree SHA (use stagedTreeSha or construct tree items)
    let treeSha = existingBranch.stagedTreeSha;

    if (!treeSha) {
      const baseCommit = await ghClient.getCommit(hostOwner, hostRepo, existingBranch.baseSha);
      const treeItems: GitTreeItem[] = [];

      for (const change of changeset.changes) {
        if (change.changeType === 'modify' || change.changeType === 'create') {
          const blobRes = await ghClient.createBlob(hostOwner, hostRepo, change.proposedContent, 'utf-8');
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

      const createdTree = await ghClient.createTree(hostOwner, hostRepo, baseCommit.tree.sha, treeItems);
      treeSha = createdTree.sha;
    }

    // 9. Generate structured, professional commit message
    const filesSummary = changeset.changes
      .map((c) => `- ${c.changeType.toUpperCase()}: ${c.filePath}`)
      .join('\n');

    const defaultCommitMessage = `[Nodal] ${changeset.summary} (v${changeset.version})\n\nFeature Plan: ${changeset.featurePlanId}\nFiles Changed:\n${filesSummary}`;
    const commitMessage = (customCommitMessage && customCommitMessage.trim()) || defaultCommitMessage;

    // 10. Create ONE commit via Git Data API
    const newCommit = await ghClient.createCommit(
      hostOwner,
      hostRepo,
      commitMessage,
      treeSha,
      [existingBranch.baseSha]
    );
    const newCommitSha = newCommit.sha;

    // 11. Advance feature branch ref (fast-forward push, NEVER force-push, NEVER modifies default branch)
    await ghClient.updateRef(hostOwner, hostRepo, `heads/${existingBranch.branchName}`, newCommitSha, false);

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
      htmlUrl: `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/tree/${encodeURIComponent(row.branch_name)}`,
      commitUrl: `https://github.com/${row.github_repo_owner}/${row.github_repo_name}/commit/${newCommitSha}`,
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
      throw new Error('Target repository not found in Nodal.');
    }

    const repoRow = repoRes.rows[0];
    if (repoRow.user_id !== userId) {
      throw new Error('Unauthorized: Target repository belongs to another user.');
    }

    if (repoRow.source_type !== 'github' || !repoRow.github_url) {
      throw new Error('This repository is not linked to GitHub.');
    }

    const parsedInfo = parseGitHubUrl(repoRow.github_url);
    const upstreamOwner = parsedInfo.owner;
    const upstreamRepo = parsedInfo.repo;

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

    this.assertSafeTargetBranch(branch.branchName, branch.baseBranch, false, {
      allowLegacyPrefix: true,
    });

    const branchHostOwner = branch.githubRepoOwner || upstreamOwner;
    const branchHostRepo = branch.githubRepoName || upstreamRepo;
    const isFork =
      branchHostOwner.toLowerCase() !== upstreamOwner.toLowerCase() ||
      branchHostRepo.toLowerCase() !== upstreamRepo.toLowerCase() ||
      Boolean(branch.metadata?.isFork);
    const prHeadParam = isFork ? `${branchHostOwner}:${branch.branchName}` : branch.branchName;

    const ghClient = await createGitHubClient(userId);

    // 6. Verify feature branch still exists on GitHub (in fork or upstream) and contains the expected commit
    const branchRef = await ghClient.getRef(
      branchHostOwner,
      branchHostRepo,
      `heads/${branch.branchName}`
    );
    if (!branchRef) {
      throw new Error(
        `Feature branch '${branch.branchName}' no longer exists on GitHub (${branchHostOwner}/${branchHostRepo}). Please recreate and commit the branch.`
      );
    }

    if (branchRef.object.sha !== branch.commitSha) {
      throw new Error(
        `Feature branch head on GitHub (${branchRef.object.sha.slice(0, 7)}) does not match the Nodal commit (${branch.commitSha.slice(0, 7)}). Aborting Pull Request creation to protect repository state.`
      );
    }

    // 7. Check upstream idempotency: Has a PR already been created on GitHub?
    const existingGhPrs = await ghClient.listPullRequests(
      upstreamOwner,
      upstreamRepo,
      `${branchHostOwner}:${branch.branchName}`,
      branch.baseBranch,
      'all'
    );

    const sharedPrMetadata = {
      isFork,
      headOwner: branchHostOwner,
      upstreamMovedWarning: branch.metadata?.upstreamMovedWarning || null,
      forkSyncWarning: branch.metadata?.forkSyncWarning || null,
    };

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
          head_owner,
          commit_sha,
          title,
          body,
          status,
          metadata,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
        ON CONFLICT (changeset_id) DO UPDATE SET
          github_pr_number = EXCLUDED.github_pr_number,
          github_pr_url = EXCLUDED.github_pr_url,
          head_owner = EXCLUDED.head_owner,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING *;
      `;

      const res = await query(insertSql, [
        changesetId,
        changeset.repositoryId,
        userId,
        upstreamOwner,
        upstreamRepo,
        match.number,
        match.html_url,
        match.url,
        branch.branchName,
        branch.baseBranch,
        branchHostOwner,
        branch.commitSha,
        match.title,
        match.body || '',
        matchStatus,
        JSON.stringify(sharedPrMetadata),
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
        headOwner: r.head_owner || branchHostOwner,
        isFork,
        commitSha: r.commit_sha,
        title: r.title,
        body: r.body,
        status: r.status,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
        createdAt: r.created_at?.toISOString?.() || new Date(r.created_at).toISOString(),
        updatedAt: r.updated_at?.toISOString?.() || new Date(r.updated_at).toISOString(),
      };
    }

    // 8. Generate deterministic PR Title & Fixes #<num> link
    let fpFeatureRequest: string | undefined;
    let fpIssueNumber: number | null = null;
    let fpIssueTitle: string | null = null;
    try {
      const fpRes = await query(
        `SELECT feature_request, issue_number, issue_title FROM feature_plans WHERE id = $1`,
        [changeset.featurePlanId]
      );
      if (fpRes.rows.length > 0) {
        fpFeatureRequest = fpRes.rows[0].feature_request;
        fpIssueNumber = fpRes.rows[0].issue_number ?? null;
        fpIssueTitle = fpRes.rows[0].issue_title ?? null;
      }
    } catch {
      // Passive
    }

    const titleSeed = fpIssueTitle || fpFeatureRequest || changeset.summary;
    const defaultTitle = `[Nodal] ${titleSeed.slice(0, 80)}`;
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

    const fixesLine = fpIssueNumber ? `Fixes #${fpIssueNumber}\n\n` : '';
    const defaultBody = `${fixesLine}## Summary
${changeset.summary || fpFeatureRequest || 'Code changes implemented by Nodal.'}

## Changes
${filesSummary}

## Validation Summary
${validationSection}

---
*Generated with Nodal • Changeset v${changeset.version} • Commit \`${branch.commitSha.slice(0, 7)}\`*`;

    const body = (customBody && customBody.trim()) || defaultBody;

    // 10. Call GitHub Pull Request API against upstream repository
    const newPr = await ghClient.createPullRequest(
      upstreamOwner,
      upstreamRepo,
      title,
      prHeadParam,
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
        head_owner,
        commit_sha,
        title,
        body,
        status,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (changeset_id) DO UPDATE SET
        github_pr_number = EXCLUDED.github_pr_number,
        github_pr_url = EXCLUDED.github_pr_url,
        head_owner = EXCLUDED.head_owner,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *;
    `;

    const prRes = await query(insertSql, [
      changesetId,
      changeset.repositoryId,
      userId,
      upstreamOwner,
      upstreamRepo,
      newPr.number,
      newPr.html_url,
      newPr.url,
      branch.branchName,
      branch.baseBranch,
      branchHostOwner,
      branch.commitSha,
      newPr.title,
      newPr.body || body,
      prStatus,
      JSON.stringify(sharedPrMetadata),
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
      headOwner: r.head_owner || branchHostOwner,
      isFork,
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
   * Contributor convenience flow: executes (optional auto-approve of 'ready') ->
   * branch/fork & stage -> commit & push -> open Pull Request in one atomic operation.
   */
  static async oneClickCreatePullRequest(
    changesetId: string,
    userId: string,
    options?: {
      title?: string;
      body?: string;
      commitMessage?: string;
      autoApprove?: boolean;
    }
  ): Promise<{ pullRequest: PullRequestRecord; branch: ChangesetBranch }> {
    await ensureDatabaseSchema();

    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset || changeset.userId !== userId) {
      throw new Error('Changeset not found.');
    }

    if (changeset.status === 'rejected') {
      throw new Error('Cannot create a Pull Request from a rejected changeset.');
    }

    if (changeset.status !== 'approved') {
      if (options?.autoApprove && changeset.status === 'ready') {
        await CodeGeneratorService.updateChangesetStatus(changesetId, 'approved');
      } else {
        throw new Error(
          `Changeset must be approved before creating a Pull Request (current status: '${changeset.status}').`
        );
      }
    }

    let branch = await this.getBranchForChangeset(changesetId, userId);
    if (!branch) {
      branch = await this.createBranchAndStageChangeset(changesetId, userId);
    }

    if (!branch.commitSha) {
      branch = await this.commitAndPushChangeset(changesetId, userId, options?.commitMessage);
    }

    const pullRequest = await this.createPullRequestForChangeset(
      changesetId,
      userId,
      options?.title,
      options?.body
    );

    const updatedBranch = (await this.getBranchForChangeset(changesetId, userId)) || branch;
    return { pullRequest, branch: updatedBranch };
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
              head_owner, commit_sha, title, body, status, metadata, created_at, updated_at
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

    const parsedMeta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;

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
      headOwner: r.head_owner ?? parsedMeta?.headOwner ?? null,
      isFork: typeof parsedMeta?.isFork === 'boolean' ? parsedMeta.isFork : undefined,
      commitSha: r.commit_sha,
      title: r.title,
      body: r.body,
      status: r.status,
      metadata: parsedMeta,
      createdAt: r.created_at?.toISOString?.() || new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at?.toISOString?.() || new Date(r.updated_at).toISOString(),
    };
  }
}

