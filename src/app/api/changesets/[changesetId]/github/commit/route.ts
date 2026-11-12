import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';
import { GitHubWriteService } from '@/server/github/githubWriteService';

/**
 * POST /api/changesets/[changesetId]/github/commit
 * Creates an atomic Git commit containing the approved changeset changes
 * and pushes/advances the dedicated feature branch on GitHub.
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

    let commitMessage: string | undefined;
    try {
      const body = await req.json();
      commitMessage = body?.commitMessage;
    } catch {
      // Empty body or no custom message provided; fallback to default
    }

    const branch = await GitHubWriteService.commitAndPushChangeset(
      changesetId,
      user.id,
      commitMessage
    );

    return NextResponse.json({
      success: true,
      branch,
    });
  } catch (error: any) {
    if (error.name === 'AuthError') {
      return handleAuthApiError(error);
    }

    const message = error?.message || 'An error occurred while creating or pushing the commit to GitHub.';
    const isConflict = message.includes('drift detected') || message.includes('changed unexpectedly');
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
 * GET /api/changesets/[changesetId]/github/commit
 * Retrieves existing commit status for a changeset's feature branch.
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
      committed: !!branch?.commitSha,
      branch: branch || null,
    });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
