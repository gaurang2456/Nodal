import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireUser, requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { FeaturePlannerService, FeaturePlannerLlmError } from '@/server/planner/featurePlannerService';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { planId } = await params;
    const user = await requireUser(req);

    const existingPlan = await FeaturePlannerService.getPlanById(planId, { userId: user.id });
    if (!existingPlan) {
      return NextResponse.json({ error: 'Feature plan not found.' }, { status: 404 });
    }

    await requireRepositoryAccess(existingPlan.repositoryId, req);

    let feedback: string | undefined;
    try {
      const body = await req.json();
      if (typeof body?.feedback === 'string') {
        feedback = body.feedback;
      }
    } catch {
      // Optional feedback body
    }

    const plan = await FeaturePlannerService.rethinkPlan(planId, user.id, feedback);
    return NextResponse.json({ success: true, plan });
  } catch (error: unknown) {
    if (error instanceof FeaturePlannerLlmError) {
      return NextResponse.json(
        { error: error.message, retryable: error.retryable },
        { status: error.status }
      );
    }
    return handleAuthApiError(error);
  }
}
