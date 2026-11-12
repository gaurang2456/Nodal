import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';
import { GitHubWriteService } from '@/server/github/githubWriteService';

/**
 * POST /api/changesets/[changesetId]/github/pr
 * Creates a GitHub Pull Request targeting the repository's default branch
 * from the committed Nodal feature branch, and persists PR metadata.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ changesetId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { changesetId } = await params;
    const user = await requireUser(req);

    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset || changeset.userId !== user.id) {
      return NextResponse.json({ success: false, error: 'Changeset not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(changeset.repositoryId, req);

    let title: string | undefined;
    let body: string | undefined;
    let oneClick = false;
    let autoApprove = false;
    let commitMessage: string | undefined;

    try {
      const json = await req.json();
      title = json?.title;
      body = json?.body;
      oneClick = Boolean(json?.oneClick);
      autoApprove = Boolean(json?.autoApprove);
      commitMessage = json?.commitMessage;
    } catch {
      // Empty body or no custom fields provided
    }

    if (oneClick) {
      const result = await GitHubWriteService.oneClickCreatePullRequest(changesetId, user.id, {
        title,
        body,
        commitMessage,
        autoApprove,
      });
      return NextResponse.json({
        success: true,
        pullRequest: result.pullRequest,
        branch: result.branch,
      });
    }

    const pullRequest = await GitHubWriteService.createPullRequestForChangeset(
      changesetId,
      user.id,
      title,
      body
    );

    return NextResponse.json({
      success: true,
      pullRequest,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AuthError') {
      return handleAuthApiError(error);
    }

    const message =
      error instanceof Error && error.message
        ? error.message
        : 'An error occurred while creating the GitHub Pull Request.';
    const isConflict =
      message.includes('changed unexpectedly') ||
      message.includes('drift detected') ||
      message.includes('409') ||
      message.includes('conflict');
    const isForbidden = message.includes('Unauthorized') || message.includes('permission') || message.includes('scope');
    const isNotFound = message.includes('not found') || message.includes('no longer exists');

    const status = isNotFound ? 404 : isForbidden ? 403 : isConflict ? 409 : 400;

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status }
    );
  }
}

/**
 * GET /api/changesets/[changesetId]/github/pr
 * Retrieves existing Pull Request information for a changeset if already created.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ changesetId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { changesetId } = await params;
    const user = await requireUser(req);

    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (!changeset || changeset.userId !== user.id) {
      return NextResponse.json({ error: 'Changeset not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(changeset.repositoryId, req);

    const pullRequest = await GitHubWriteService.getPullRequestForChangeset(changesetId, user.id);

    return NextResponse.json({
      success: true,
      pullRequest: pullRequest || null,
    });
  } catch (error: unknown) {
    return handleAuthApiError(error);
  }
}
