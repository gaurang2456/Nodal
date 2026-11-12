import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ changesetId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { changesetId } = await params;
    const user = await requireUser(req);

    const existing = await CodeGeneratorService.getChangesetById(changesetId);
    if (!existing || existing.userId !== user.id) {
      return NextResponse.json({ error: 'Changeset not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(existing.repositoryId, req);

    const body = await req.json();
    const status = body.status;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return NextResponse.json(
        { error: "Invalid status. Must be 'approved' or 'rejected'." },
        { status: 400 }
      );
    }

    const updated = await CodeGeneratorService.updateChangesetStatus(changesetId, status);

    return NextResponse.json({ success: true, changeset: updated });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
