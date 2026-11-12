import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';
import { GitHubWriteService } from '@/server/github/githubWriteService';

/**
 * POST /api/changesets/[changesetId]/github/pr
 * Creates a GitHub Pull Request targeting the repository's default branch
 * from the committed CodeGraph feature branch, and persists PR metadata.
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

    try {
      const json = await req.json();
      title = json?.title;
      body = json?.body;
    } catch {
      // Empty body or no custom fields provided
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
  } catch (error: any) {
    if (error.name === 'AuthError') {
      return handleAuthApiError(error);
    }

    const message = error?.message || 'An error occurred while creating the GitHub Pull Request.';
    const isConflict = message.includes('changed unexpectedly') || message.includes('drift detected');
    const isForbidden = message.includes('Unauthorized') || message.includes('permission');
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
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
