import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { FeaturePlannerService, FeaturePlannerLlmError } from '@/server/planner/featurePlannerService';
import { parseGitHubIssueUrl, GitHubApiError } from '@/server/github/githubClient';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { id } = await params;
    const { user } = await requireRepositoryAccess(id, req);

    const body = await req.json().catch(() => ({}));
    const featureRequest = body.feature || body.featureRequest || body.prompt;

    if (!featureRequest || typeof featureRequest !== 'string' || !featureRequest.trim()) {
      return NextResponse.json(
        { error: 'Issue description is required.' },
        { status: 400 }
      );
    }

    let issueUrl: string | null = null;
    let issueNumber: number | null = null;
    const issueTitle: string | null =
      typeof body.issueTitle === 'string' && body.issueTitle.trim()
        ? body.issueTitle.trim().slice(0, 500)
        : null;

    if (typeof body.issueUrl === 'string' && body.issueUrl.trim()) {
      const parsed = parseGitHubIssueUrl(body.issueUrl.trim());
      issueUrl = parsed.normalizedUrl;
      issueNumber = parsed.issueNumber;
    }

    const plan = await FeaturePlannerService.generatePlan(id, featureRequest.trim(), user.id, {
      issueUrl,
      issueNumber,
      issueTitle,
    });

    return NextResponse.json({ success: true, plan });
  } catch (error: any) {
    if (error instanceof GitHubApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof FeaturePlannerLlmError) {
      return NextResponse.json(
        {
          error: error.message,
          retryable: error.retryable,
          code: 'LLM_GENERATION_FAILED',
        },
        { status: error.status }
      );
    }
    return handleAuthApiError(error);
  }
}
