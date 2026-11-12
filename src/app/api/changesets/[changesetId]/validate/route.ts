import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';
import { CodeValidationService } from '@/server/validation/codeValidationService';

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
      return NextResponse.json({ error: 'Changeset not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(changeset.repositoryId, req);

    const result = await CodeValidationService.validateChangeset(changesetId, user.id);

    return NextResponse.json({ success: true, validation: result });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
