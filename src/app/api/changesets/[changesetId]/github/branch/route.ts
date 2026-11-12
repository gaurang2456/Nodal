import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';
import { GitHubWriteService } from '@/server/github/githubWriteService';

/**
 * POST /api/changesets/[changesetId]/github/branch
 * Creates a dedicated feature branch from the target repository's default branch
 * and stages the approved changeset via GitHub's Git Data API.
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

    const branch = await GitHubWriteService.createBranchAndStageChangeset(changesetId, user.id);

    return NextResponse.json({
      success: true,
      branch,
    });
  } catch (error: any) {
    if (error.name === 'AuthError') {
      return handleAuthApiError(error);
    }

    const message = error?.message || 'An error occurred during GitHub branch creation.';
    const isDrift = message.includes('drift detected');
    const isForbidden = message.includes('Unauthorized') || message.includes('permission');
    const isNotFound = message.includes('not found');

    const status = isNotFound ? 404 : isForbidden ? 403 : isDrift ? 409 : 400;

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
 * GET /api/changesets/[changesetId]/github/branch
 * Retrieves existing branch information for a changeset if already created.
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

    const branch = await GitHubWriteService.getBranchForChangeset(changesetId, user.id);

    return NextResponse.json({
      success: true,
      branch,
    });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
