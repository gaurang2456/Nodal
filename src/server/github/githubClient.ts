import { GitHubConnectionService } from './githubConnectionService';

export interface GitHubUserProfile {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url: string;
  email?: string | null;
}

export interface GitHubRepoPermissions {
  admin: boolean;
  maintain?: boolean;
  push: boolean;
  triage?: boolean;
  pull: boolean;
}

export interface GitHubRepoDetails {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description?: string | null;
  permissions?: GitHubRepoPermissions;
}

export interface GitTreeItem {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha: string | null;
}

export interface GitCommitDetails {
  sha: string;
  tree: { sha: string; url: string };
  message: string;
  parents: Array<{ sha: string }>;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
}

export interface GitHubPullRequestDetails {
  id: number;
  number: number;
  html_url: string;
  url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged?: boolean;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
}

export interface ParsedGitHubIssueUrl {
  owner: string;
  repo: string;
  issueNumber: number;
  normalizedUrl: string;
}

export interface GitHubIssueDetails {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | string;
  html_url: string;
  pull_request?: unknown;
}

export class GitHubApiError extends Error {
  public status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/**
 * Strictly validates a GitHub issue URL matching https://github.com/<owner>/<repo>/issues/<number>.
 * Rejects other hosts, SSRF targets, embedded credentials, and Pull Request URLs.
 */
export function parseGitHubIssueUrl(rawUrl: string): ParsedGitHubIssueUrl {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new GitHubApiError('Please provide a GitHub issue URL.', 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new GitHubApiError(
      'Invalid URL. Expected format: https://github.com/owner/repo/issues/123',
      400
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GitHubApiError('Only https://github.com issue URLs are supported.', 400);
  }

  if (parsed.username || parsed.password) {
    throw new GitHubApiError('Invalid GitHub URL.', 400);
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new GitHubApiError(
      'Only github.com issue URLs are allowed (e.g. https://github.com/owner/repo/issues/123).',
      400
    );
  }

  if (/^\/[^/]+\/[^/]+\/pull\//i.test(parsed.pathname)) {
    throw new GitHubApiError(
      'Pull request URLs are not supported here. Please paste a GitHub issue URL (/owner/repo/issues/123).',
      400
    );
  }

  const match = parsed.pathname.match(
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/
  );

  if (!match) {
    throw new GitHubApiError(
      'URL must match https://github.com/<owner>/<repo>/issues/<number>.',
      400
    );
  }

  const [, owner, repo, numStr] = match;
  const issueNumber = Number.parseInt(numStr, 10);

  return {
    owner,
    repo,
    issueNumber,
    normalizedUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  };
}

/**
 * Fetches a GitHub issue using optional user OAuth token (required for private repos).
 */
export async function fetchGitHubIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  token?: string | null
): Promise<GitHubIssueDetails> {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Nodal-Platform/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err: any) {
    throw new GitHubApiError(
      `Failed to contact GitHub while fetching issue #${issueNumber}: ${err?.message || 'Network timeout'}`,
      504
    );
  }

  if (!response.ok) {
    let rawMsg = '';
    try {
      const errJson = await response.json();
      rawMsg = errJson.message || '';
    } catch {
      rawMsg = await response.text().catch(() => '');
    }
    const safeMsg = token ? rawMsg.replaceAll(token, '[REDACTED_TOKEN]') : rawMsg;

    if (response.status === 404) {
      throw new GitHubApiError(
        token
          ? `Issue #${issueNumber} in ${owner}/${repo} was not found, or your connected GitHub account does not have access to it.`
          : `Issue #${issueNumber} in ${owner}/${repo} was not found. If this is a private repository, connect your GitHub account with repo access.`,
        404
      );
    }

    if (response.status === 401) {
      throw new GitHubApiError(
        'Your connected GitHub token is invalid or expired. Please reconnect your GitHub account.',
        401
      );
    }

    if (response.status === 403) {
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
      if (rateLimitRemaining === '0') {
        throw new GitHubApiError(
          token
            ? 'GitHub API rate limit exceeded. Please try again in a few minutes.'
            : 'GitHub unauthenticated API rate limit exceeded. Connect your GitHub account or try again later.',
          429
        );
      }
      throw new GitHubApiError(
        `GitHub denied access to ${owner}/${repo}#${issueNumber}: ${safeMsg || 'Missing permissions or token scope.'}`,
        403
      );
    }

    throw new GitHubApiError(
      `GitHub API error (${response.status}): ${safeMsg || response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as GitHubIssueDetails;
  if (data.pull_request) {
    throw new GitHubApiError(
      `${owner}/${repo}#${issueNumber} is a pull request, not an issue.`,
      400
    );
  }

  return {
    id: data.id,
    number: data.number,
    title: data.title || '',
    body: data.body || '',
    state: data.state || 'open',
    html_url: data.html_url || `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  };
}

export class GitHubApiClient {
  private token: string;
  private baseUrl: string = 'https://api.github.com';

  constructor(token: string) {
    if (!token) {
      throw new Error('A valid GitHub access token is required to initialize GitHubApiClient.');
    }
    this.token = token;
  }

  /**
   * Performs an authenticated request to the GitHub REST API.
   * SECURITY: Tokens are stripped from error messages and never logged.
   */
  async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Nodal-Platform/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers as Record<string, string> || {}),
    };

    if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        let errorDetails = '';
        try {
          const json = await response.json();
          errorDetails = json.message || '';
        } catch {
          errorDetails = await response.text().catch(() => '');
        }

        // Clean out any accidental token reflections
        const sanitizedDetails = errorDetails.replace(new RegExp(this.token, 'g'), '[REDACTED_TOKEN]');
        const scopeHint =
          response.status === 403
            ? " Your connected GitHub account may lack required repository permissions or 'repo' / 'public_repo' OAuth scope."
            : '';
        const apiErr = new Error(
          `GitHub API request failed [${response.status}]: ${sanitizedDetails || response.statusText}${scopeHint}`
        );
        (apiErr as any).status = response.status;
        throw apiErr;
      }

      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    } catch (err: any) {
      const safeMessage = (err?.message || 'Unknown GitHub API error').replace(
        new RegExp(this.token, 'g'),
        '[REDACTED_TOKEN]'
      );
      const wrapped = new Error(safeMessage);
      if (typeof err?.status === 'number') {
        (wrapped as any).status = err.status;
      }
      throw wrapped;
    }
  }

  /**
   * Retrieves the authenticated GitHub user's profile.
   */
  async getUser(): Promise<GitHubUserProfile> {
    return this.request<GitHubUserProfile>('/user');
  }

  /**
   * Retrieves repository metadata for a given owner and repo name.
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepoDetails> {
    return this.request<GitHubRepoDetails>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  /**
   * Reads a Git reference (e.g. heads/main or heads/feature-xyz).
   * Returns null if not found (404).
   */
  async getRef(
    owner: string,
    repo: string,
    ref: string
  ): Promise<{ ref: string; object: { sha: string; type: string } } | null> {
    const cleanRef = ref.replace(/^refs\//, '');
    try {
      return await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${cleanRef}`);
    } catch (err: any) {
      if (err.message && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Creates a Git reference (branch).
   * ref should typically be in format: 'refs/heads/branch-name'
   */
  async createRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string
  ): Promise<{ ref: string; object: { sha: string; type: string } }> {
    const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: fullRef,
        sha,
      }),
    });
  }

  /**
   * Fetches raw or decoded content of a file on GitHub at a given ref (branch, commit SHA).
   * Returns null if file does not exist (404).
   */
  async getFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref?: string
  ): Promise<GitHubFileContent | null> {
    const encodedPath = filePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    try {
      return await this.request<GitHubFileContent>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${query}`
      );
    } catch (err: any) {
      if (err.message && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Creates a Git blob in GitHub's object store.
   */
  async createBlob(
    owner: string,
    repo: string,
    content: string,
    encoding: 'utf-8' | 'base64' = 'utf-8'
  ): Promise<{ sha: string; url: string }> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        encoding,
      }),
    });
  }

  /**
   * Reads a Git commit to get its base tree and metadata.
   */
  async getCommit(owner: string, repo: string, commitSha: string): Promise<GitCommitDetails> {
    return this.request<GitCommitDetails>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${commitSha}`
    );
  }

  /**
   * Creates a new Git tree from a base tree and a list of tree items.
   * Enables staging multi-file additions, modifications, and deletions without creating a commit.
   */
  async createTree(
    owner: string,
    repo: string,
    baseTreeSha: string,
    treeItems: GitTreeItem[]
  ): Promise<{ sha: string; url: string }> {
    return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: treeItems,
      }),
    });
  }

  /**
   * Creates a Git commit in GitHub's object store.
   */
  async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parents: string[]
  ): Promise<GitCommitDetails> {
    return this.request<GitCommitDetails>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents,
        }),
      }
    );
  }

  /**
   * Updates a Git reference (pushes a commit to a branch).
   * force defaults to false to enforce safe fast-forward updates.
   */
  async updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    force: boolean = false
  ): Promise<{ ref: string; object: { sha: string; type: string } }> {
    const cleanRef = ref.replace(/^refs\//, '');
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${cleanRef}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          sha,
          force,
        }),
      }
    );
  }

  /**
   * Creates a Pull Request on GitHub.
   */
  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string
  ): Promise<GitHubPullRequestDetails> {
    return this.request<GitHubPullRequestDetails>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title,
          head,
          base,
          body: body || '',
        }),
      }
    );
  }

  /**
   * Lists Pull Requests for a repository, optionally filtered by head branch, base branch, and state.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    head?: string,
    base?: string,
    state: 'open' | 'closed' | 'all' = 'all'
  ): Promise<GitHubPullRequestDetails[]> {
    const params = new URLSearchParams();
    params.set('state', state);
    if (head) params.set('head', head);
    if (base) params.set('base', base);

    return this.request<GitHubPullRequestDetails[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`
    );
  }

  /**
   * Creates or returns an existing fork of upstream owner/repo under the authenticated user's account.
   */
  async createFork(owner: string, repo: string): Promise<GitHubRepoDetails> {
    return this.request<GitHubRepoDetails>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`,
      {
        method: 'POST',
        body: JSON.stringify({ default_branch_only: true }),
      }
    );
  }

  /**
   * Syncs a fork's branch with the upstream repository using POST /repos/{owner}/{repo}/merge-upstream.
   * Returns HTTP status explicitly so 409 conflicts can be handled gracefully without crashing.
   */
  async syncForkUpstream(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ ok: boolean; status: number; message?: string; mergeType?: string }> {
    const url = `${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/merge-upstream`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Nodal-Platform/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ branch }),
      });

      let payload: any = {};
      try {
        payload = await response.json();
      } catch {
        // Ignore non-JSON body
      }

      const rawMessage = typeof payload?.message === 'string' ? payload.message : response.statusText;
      const safeMessage = rawMessage.replace(new RegExp(this.token, 'g'), '[REDACTED_TOKEN]');

      return {
        ok: response.ok,
        status: response.status,
        message: safeMessage,
        mergeType: payload?.merge_type,
      };
    } catch (err: any) {
      const safeMessage = (err?.message || 'Failed to sync fork with upstream').replace(
        new RegExp(this.token, 'g'),
        '[REDACTED_TOKEN]'
      );
      return {
        ok: false,
        status: 500,
        message: safeMessage,
      };
    }
  }

  /**
   * Checks branch metadata (such as whether the branch is protected).
   * Returns null gracefully if inaccessible or not found.
   */
  async getBranchInfo(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ name: string; protected?: boolean } | null> {
    try {
      return await this.request<{ name: string; protected?: boolean }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`
      );
    } catch {
      return null;
    }
  }
}

/**
 * Factory to create an authenticated GitHubApiClient for the given Nodal user.
 * Strictly verifies the user has a GitHub connection before instantiating the client.
 */
export async function createGitHubClient(userId: string): Promise<GitHubApiClient> {
  if (!userId) {
    throw new Error('User ID is required to create a GitHub API client.');
  }

  const token = await GitHubConnectionService.getRawGitHubTokenForUser(userId);

  if (!token) {
    throw new Error('No GitHub account connected for this user. Please connect your GitHub account first.');
  }

  return new GitHubApiClient(token);
}
