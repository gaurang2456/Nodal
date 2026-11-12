import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { FeaturePlannerService } from '@/server/planner/featurePlannerService';
import { CodeGeneratorService } from '@/server/planner/codeGeneratorService';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { planId } = await params;
    const user = await requireUser(req);

    const plan = await FeaturePlannerService.getPlanById(planId, { userId: user.id });
    if (!plan) {
      return NextResponse.json({ error: 'Feature plan not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(plan.repositoryId, req);

    const changesets = await CodeGeneratorService.getAllChangesetsForPlan(planId);

    return NextResponse.json({ success: true, changesets });
  } catch (error: any) {
    return handleAuthApiError(error);
  }
}
