import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { FeaturePlannerService } from '@/server/planner/featurePlannerService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { planId } = await params;
    const user = await requireUser(req);

    const expectedRepoId = req.nextUrl.searchParams.get('repositoryId')?.trim() || undefined;

    const plan = await FeaturePlannerService.getPlanById(planId, {
      repositoryId: expectedRepoId,
      userId: user.id,
    });
    if (!plan) {
      return NextResponse.json({ error: 'Feature plan not found.' }, { status: 404 });
    }

    // Verify repository ownership
    await requireRepositoryAccess(plan.repositoryId, req);

    return NextResponse.json({ success: true, plan });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
