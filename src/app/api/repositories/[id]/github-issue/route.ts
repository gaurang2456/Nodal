import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { GitHubConnectionService } from '@/server/github/githubConnectionService';
import {
  parseGitHubIssueUrl,
  fetchGitHubIssue,
  GitHubApiError,
} from '@/server/github/githubClient';
import { parseGitHubUrl } from '@/server/ingestion/githubIngestion';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { id } = await params;
    const { user, repository } = await requireRepositoryAccess(id, req);

    const body = await req.json().catch(() => ({}));
    const rawUrl = body?.issueUrl || body?.url;

    const parsed = parseGitHubIssueUrl(rawUrl);
    const token = await GitHubConnectionService.getRawGitHubTokenForUser(user.id);
    const ghIssue = await fetchGitHubIssue(parsed.owner, parsed.repo, parsed.issueNumber, token);

    let repoMismatchWarning: string | null = null;
    let indexedRepo: string | null = null;

    if (repository.source_type === 'github' && repository.github_url) {
      try {
        const repoInfo = parseGitHubUrl(repository.github_url);
        indexedRepo = repoInfo.fullName;
        if (
          repoInfo.owner.toLowerCase() !== parsed.owner.toLowerCase() ||
          repoInfo.repo.toLowerCase() !== parsed.repo.toLowerCase()
        ) {
          repoMismatchWarning = `Fetched issue belongs to ${parsed.owner}/${parsed.repo}, which differs from the indexed repository (${repoInfo.fullName}). Plans will still be generated against ${repoInfo.fullName}.`;
        }
      } catch {
        // Ignore unparseable legacy github_url
      }
    }

    return NextResponse.json({
      success: true,
      issue: {
        owner: parsed.owner,
        repo: parsed.repo,
        issueNumber: ghIssue.number,
        issueUrl: parsed.normalizedUrl,
        title: ghIssue.title,
        body: ghIssue.body,
        state: ghIssue.state,
        repoMismatchWarning,
        indexedRepo,
      },
    });
  } catch (error: any) {
    if (error instanceof GitHubApiError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return handleAuthApiError(error);
  }
}

