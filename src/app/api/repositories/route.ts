import { NextRequest, NextResponse } from 'next/server';
import { ensureDatabaseSchema, query } from '@/server/db/client';
import { extractZipArchive } from '@/server/ingestion/zipExtractor';
import { downloadGitHubRepository, parseGitHubUrl } from '@/server/ingestion/githubIngestion';
import { IndexingPipeline } from '@/server/ingestion/indexingPipeline';
import { requireUser, handleAuthApiError } from '@/server/auth/authHelper';

export async function GET(req: NextRequest) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(req);

    // Return only repositories strictly belonging to the authenticated user
    const result = await query(
      `SELECT id, name, full_name, source_type, github_url, branch, indexed_commit_sha, user_id, status, stage, progress,
              file_count, folder_count, line_count, token_count, primary_language, framework,
              technologies, summary, stats, error_message, last_opened_at, created_at, updated_at
       FROM repositories
       WHERE user_id = $1
       ORDER BY last_opened_at DESC NULLS LAST, created_at DESC`,
      [user.id]
    );

    return NextResponse.json({ repositories: result.rows });
  } catch (error: unknown) {
    return handleAuthApiError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureDatabaseSchema();
    const user = await requireUser(req);

    const contentType = req.headers.get('content-type') || '';

    const repositoryId = `repo-${Date.now()}`;
    let repoName = 'Uploaded-Repository';
    let fullName = 'local/uploaded-repository';
    let sourceType: 'zip' | 'github' = 'zip';
    let githubUrl: string | undefined = undefined;
    let extractorFn: () => Promise<Awaited<ReturnType<typeof extractZipArchive>>>;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const customName = formData.get('name') as string | null;

      if (!file) {
        return NextResponse.json({ error: 'No ZIP archive file provided.' }, { status: 400 });
      }

      if (!file.name.endsWith('.zip')) {
        return NextResponse.json({ error: 'Only .zip files are supported.' }, { status: 400 });
      }

      repoName = customName || file.name.replace(/\.zip$/i, '');
      fullName = `uploads/${repoName}`;
      sourceType = 'zip';

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      extractorFn = async () => extractZipArchive(buffer);
    } else {
      // JSON body for GitHub URL
      const body = await req.json();
      const inputUrl = body.githubUrl || body.url;

      if (!inputUrl) {
        return NextResponse.json({ error: 'GitHub repository URL is required.' }, { status: 400 });
      }

      const info = parseGitHubUrl(inputUrl);
      repoName = info.repo;
      fullName = info.fullName;
      githubUrl = info.htmlUrl;
      sourceType = 'github';

      extractorFn = async () => {
        const { info: downloadedInfo, files } = await downloadGitHubRepository(inputUrl);
        await query(
          `UPDATE repositories
           SET branch = $2, indexed_commit_sha = $3, updated_at = NOW()
           WHERE id = $1`,
          [repositoryId, downloadedInfo.defaultBranch, downloadedInfo.commitSha || null]
        );
        return files;
      };
    }

    // Insert initial record with authenticated user_id
    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, github_url, user_id, status, stage, progress)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'Pending Ingestion', 0)`,
      [repositoryId, repoName, fullName, sourceType, githubUrl || null, user.id]
    );

    // Launch indexing in background without blocking HTTP response
    setTimeout(() => {
      IndexingPipeline.run(repositoryId, extractorFn).catch((err) => {
        console.error(`Background indexing unhandled error for ${repositoryId}:`, err);
      });
    }, 100);

    return NextResponse.json(
      {
        id: repositoryId,
        name: repoName,
        status: 'PENDING',
        stage: 'Pending Ingestion',
        progress: 0,
      },
      { status: 201 }
    );
  } catch (error: unknown) {
    return handleAuthApiError(error);
  }
}
