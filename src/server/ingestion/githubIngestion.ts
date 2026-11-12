import { extractZipArchive, ExtractedFile } from './zipExtractor';
import { shouldIndexFile, detectLanguage, sanitizePostgresText } from './fileFilter';
import path from 'path';

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  commitSha?: string;
}

async function resolveBranchHeadCommitSha(
  owner: string,
  repo: string,
  branch: string
): Promise<string | undefined> {
  const headers = {
    'User-Agent': 'CodeGraph-Ingestion-Engine/1.0',
    Accept: 'application/vnd.github.v3+json',
  };
  try {
    const refRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (refRes.ok) {
      const refData = await refRes.json();
      if (typeof refData?.object?.sha === 'string' && refData.object.sha) {
        return refData.object.sha;
      }
    }
  } catch {
    // Fallback to commits endpoint below
  }

  try {
    const commitRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
      { headers, signal: AbortSignal.timeout(5000) }
    );
    if (commitRes.ok) {
      const commitData = await commitRes.json();
      if (typeof commitData?.sha === 'string' && commitData.sha) {
        return commitData.sha;
      }
    }
  } catch {
    // Non-fatal
  }

  return undefined;
}

/**
 * Parses and validates a public GitHub URL or owner/repo format.
 */
export function parseGitHubUrl(input: string): GitHubRepoInfo {
  let cleaned = input.trim();
  cleaned = cleaned.replace(/^git@github\.com:/, 'https://github.com/');
  cleaned = cleaned.replace(/\.git$/, '');

  const match =
    cleaned.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i) ||
    cleaned.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);

  if (!match) {
    throw new Error(
      `Invalid GitHub repository URL: "${input}". Format should be https://github.com/owner/repository or owner/repository.`
    );
  }

  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    defaultBranch: 'main',
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

/**
 * Downloads and extracts a public GitHub repository.
 * Pre-filters out node_modules and binary files via Git Tree, then fetches clean source files.
 */
export async function downloadGitHubRepository(
  urlOrRepo: string
): Promise<{ info: GitHubRepoInfo; files: ExtractedFile[] }> {
  const info = parseGitHubUrl(urlOrRepo);
  const branchesToTry = ['main', 'master'];

  // 1. Try resolving the default branch via GitHub API metadata
  try {
    const metaRes = await fetch(`https://api.github.com/repos/${info.owner}/${info.repo}`, {
      headers: {
        'User-Agent': 'CodeGraph-Ingestion-Engine/1.0',
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta.default_branch && !branchesToTry.includes(meta.default_branch)) {
        branchesToTry.unshift(meta.default_branch);
      }
    }
  } catch (_) {}

  // 2. Fast Tree Ingestion: Query Git Tree, filter out node_modules, and fetch only clean source files
  for (const branch of branchesToTry) {
    try {
      const treeRes = await fetch(
        `https://api.github.com/repos/${info.owner}/${info.repo}/git/trees/${branch}?recursive=1`,
        {
          headers: {
            'User-Agent': 'CodeGraph-Ingestion-Engine/1.0',
            Accept: 'application/vnd.github.v3+json',
          },
          signal: AbortSignal.timeout(12000),
        }
      );

      if (treeRes.ok) {
        const treeData = await treeRes.json();
        const rawTree: Array<{ path: string; type: string; url?: string; sha?: string }> = treeData.tree || [];

        // Filter out all node_modules, target, dist, build, and binary files
        const sourceBlobs = rawTree.filter(
          (item) => item.type === 'blob' && shouldIndexFile(item.path)
        );

        if (sourceBlobs.length > 0) {
          info.defaultBranch = branch;
          const extractedFiles: ExtractedFile[] = [];
          const BATCH_SIZE = 20;

          for (let i = 0; i < sourceBlobs.length; i += BATCH_SIZE) {
            const batch = sourceBlobs.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (blob) => {
              // Try CDN and API endpoints with automatic fallback
              const urls = [
                `https://cdn.jsdelivr.net/gh/${info.owner}/${info.repo}@${branch}/${blob.path}`,
                blob.sha ? `https://api.github.com/repos/${info.owner}/${info.repo}/git/blobs/${blob.sha}` : '',
                `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${branch}/${blob.path}`,
              ].filter(Boolean);

              for (const u of urls) {
                try {
                  const res = await fetch(u, {
                    headers: { 'User-Agent': 'CodeGraph-Ingestion-Engine/1.0' },
                    signal: AbortSignal.timeout(10000),
                  });

                  if (res.ok) {
                    let content = '';
                    if (u.includes('/git/blobs/')) {
                      const json = await res.json();
                      if (json.content) {
                        content = Buffer.from(json.content, 'base64').toString('utf8');
                      }
                    } else {
                      content = await res.text();
                    }

                    if (content) {
                      const cleanContent = sanitizePostgresText(content);
                      const fileName = path.basename(blob.path);
                      const extension = path.extname(fileName).toLowerCase();
                      const language = detectLanguage(blob.path);
                      const lineCount = cleanContent.split(/\r\n|\r|\n/).length;

                      return {
                        filePath: blob.path,
                        fileName,
                        extension,
                        language,
                        content: cleanContent,
                        lineCount,
                      };
                    }
                  }
                } catch (_) {}
              }
              return null;
            });

            const batchResults = await Promise.all(batchPromises);
            for (const f of batchResults) {
              if (f) extractedFiles.push(f);
            }
          }

          if (extractedFiles.length > 0) {
            info.commitSha = await resolveBranchHeadCommitSha(info.owner, info.repo, branch);
            console.log(`⚡ Fast Ingestion: Retrieved ${extractedFiles.length} clean source files for ${info.fullName} (skipped node_modules/binaries).`);
            return {
              info,
              files: extractedFiles,
            };
          }
        }
      }
    } catch (_) {}
  }

  // 3. Fallback to direct archive extraction
  let downloadedBuffer: ArrayBuffer | null = null;
  let lastError: string = '';

  for (const branch of branchesToTry) {
    const downloadUrls = [
      `https://codeload.github.com/${info.owner}/${info.repo}/zip/refs/heads/${branch}`,
      `https://github.com/${info.owner}/${info.repo}/archive/refs/heads/${branch}.zip`,
    ];

    for (const url of downloadUrls) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'CodeGraph-Ingestion-Engine/1.0',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(180000),
        });

        if (res.ok) {
          downloadedBuffer = await res.arrayBuffer();
          info.defaultBranch = branch;
          break;
        } else if (res.status === 404) {
          lastError = `Branch '${branch}' not found on ${info.fullName}.`;
        }
      } catch (err: any) {
        lastError = err?.message || 'Download request timed out.';
      }
    }

    if (downloadedBuffer) break;
  }

  if (!downloadedBuffer) {
    throw new Error(
      `Could not download repository '${info.fullName}'. ${lastError || 'Please ensure the repository is public and contains a main or master branch.'}`
    );
  }

  const files = await extractZipArchive(downloadedBuffer);

  if (files.length === 0) {
    throw new Error(
      `Repository '${info.fullName}' was downloaded successfully but contained 0 indexable source files.`
    );
  }

  info.commitSha = await resolveBranchHeadCommitSha(info.owner, info.repo, info.defaultBranch);

  return {
    info,
    files,
  };
}
