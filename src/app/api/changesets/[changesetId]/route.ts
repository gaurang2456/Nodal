import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ changesetId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { changesetId } = await params;
    const user = await requireUser(req);

    const expectedRepoId = req.nextUrl.searchParams.get('repositoryId')?.trim() || undefined;
    const expectedPlanId = req.nextUrl.searchParams.get('planId')?.trim() || undefined;

    const changeset = await CodeGeneratorService.getChangesetById(changesetId);
    if (
      !changeset ||
      changeset.userId !== user.id ||
      (expectedRepoId && changeset.repositoryId !== expectedRepoId) ||
      (expectedPlanId && changeset.featurePlanId !== expectedPlanId)
    ) {
      return NextResponse.json({ error: 'Changeset not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(changeset.repositoryId, req);

    return NextResponse.json({ success: true, changeset });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
