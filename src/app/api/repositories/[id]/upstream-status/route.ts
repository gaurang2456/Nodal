import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema } from '@/server/db/client';
import { requireRepositoryAccess, handleAuthApiError } from '@/server/auth/authHelper';
import { parseGitHubUrl } from '@/server/ingestion/githubIngestion';
import { GitHubConnectionService } from '@/server/github/githubConnectionService';
import { GitHubApiClient } from '@/server/github/githubClient';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureDatabaseSchema();
    const { id } = await params;
    const { user, repository } = await requireRepositoryAccess(id, req);

    if (repository.source_type !== 'github' || !repository.github_url) {
      return NextResponse.json({
        isGitHub: false,
        upstreamMoved: false,
        indexedCommitSha: null,
        liveHeadSha: null,
      });
    }

    const parsed = parseGitHubUrl(repository.github_url);
    const defaultBranch = repository.branch || 'main';
    const indexedCommitSha: string | null = repository.indexed_commit_sha || null;

    const token = await GitHubConnectionService.getRawGitHubTokenForUser(user.id).catch(() => null);

    let liveHeadSha: string | null = null;
    let hasPushAccess: boolean | null = null;
    let resolvedBranch = defaultBranch;

    if (token) {
      try {
        const gh = new GitHubApiClient(token);
        const ghRepo = await gh.getRepository(parsed.owner, parsed.repo);
        resolvedBranch = ghRepo.default_branch || defaultBranch;
        if (ghRepo.permissions) {
          hasPushAccess = Boolean(
            ghRepo.permissions.push || ghRepo.permissions.admin || ghRepo.permissions.maintain
          );
        }
        const ref = await gh.getRef(parsed.owner, parsed.repo, `heads/${resolvedBranch}`);
        liveHeadSha = ref?.object?.sha || null;
      } catch {
        // Non-fatal; fallback cleanly
      }
    } else {
      try {
        const refRes = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
          {
            headers: {
              'User-Agent': 'CodeGraph-Platform/1.0',
              Accept: 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (refRes.ok) {
          const refJson = await refRes.json();
          liveHeadSha = refJson?.object?.sha || null;
        }
      } catch {
        // Non-fatal
      }
    }

    const upstreamMoved = Boolean(
      indexedCommitSha && liveHeadSha && indexedCommitSha !== liveHeadSha
    );

    const warning = upstreamMoved
      ? `Upstream '${parsed.owner}/${parsed.repo}:${resolvedBranch}' has new commits since CodeGraph indexed it (indexed at ${indexedCommitSha!.slice(
          0,
          7
        )}, live HEAD is ${liveHeadSha!.slice(0, 7)}). Creating a PR will check affected files for conflicts.`
      : null;

    return NextResponse.json({
      isGitHub: true,
      upstreamOwner: parsed.owner,
      upstreamRepo: parsed.repo,
      branch: resolvedBranch,
      indexedCommitSha,
      liveHeadSha,
      upstreamMoved,
      hasPushAccess,
      warning,
    });
  } catch (error: unknown) {
    return handleAuthApiError(error);
  }
}
