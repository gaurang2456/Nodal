import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Repository,
  ArchitectureFlow,
  FileTreeNode,
  FeaturePlanRecord,
  GeneratedChangeset,
  GitHubConnectionStatus,
  GitHubIssueFetchResult,
  ChangesetBranch,
  PullRequestRecord,
  ValidationResult,
} from '@/types';
import { GraphApiResponse } from '@/components/graph/graphUtils';

export function mapBackendRepoToRepository(r: any): Repository {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    sourceType: r.source_type,
    url: r.github_url,
    primaryLanguage: r.primary_language || 'Code',
    framework: r.framework || 'Standard',
    fileCount: r.file_count || 0,
    folderCount: r.folder_count || 0,
    estimatedTokens: r.token_count || 0,
    branch: r.branch || 'main',
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    lastIndexedAt: new Date(r.updated_at || r.created_at).toLocaleDateString(),
    createdAt: r.created_at || undefined,
    lastOpenedAt: r.last_opened_at || null,
    stats: r.stats,
    technologies: r.technologies || [],
    summary: r.summary || {
      projectType: 'Repository',
      architecture: 'Modular',
      backend: 'Standard',
      frontend: 'N/A',
      database: 'N/A',
      authentication: 'Standard',
      description: `Repository ${r.name}`,
      keyPackages: [],
    },
    errorMessage: r.error_message,
  };
}

export const REPOSITORY_KEYS = {
  all: ['repositories'] as const,
  detail: (id: string) => ['repository', id] as const,
};

/**
 * Fetches and caches the list of all repositories for the authenticated user.
 * Stale time: 5 minutes.
 */
export function useRepositories() {
  return useQuery({
    queryKey: REPOSITORY_KEYS.all,
    queryFn: async (): Promise<Repository[]> => {
      const res = await fetch('/api/repositories');
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch repositories.');
      }
      const data = await res.json();
      return (data.repositories || []).map(mapBackendRepoToRepository);
    },
    retry: (failureCount, error: Error) => error.message !== 'UNAUTHORIZED' && failureCount < 1,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Fetches and caches a single repository by ID.
 * Stale time: 5 minutes.
 */
export function useRepository(repoId: string | null | undefined) {
  return useQuery({
    queryKey: repoId ? REPOSITORY_KEYS.detail(repoId) : (['repository', 'null'] as const),
    queryFn: async (): Promise<Repository> => {
      const res = await fetch(`/api/repositories/${encodeURIComponent(repoId!)}`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (res.status === 404) {
        throw new Error('NOT_FOUND');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch repository.');
      }
      const data = await res.json();
      return mapBackendRepoToRepository(data.repository);
    },
    enabled: Boolean(repoId),
    retry: (failureCount, error: Error) =>
      error.message !== 'NOT_FOUND' && error.message !== 'UNAUTHORIZED' && failureCount < 1,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Records that the authenticated user opened a repository (persisting last_opened_at).
 */
export async function markRepositoryOpened(repoId: string): Promise<string | null> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(repoId)}/open`, {
    method: 'POST',
  });
  if (res.status === 401) {
    throw new Error('UNAUTHORIZED');
  }
  if (res.status === 404) {
    throw new Error('NOT_FOUND');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to record repository open.');
  }
  const data = await res.json();
  return data.last_opened_at || null;
}

/**
 * Targeted cache invalidations for repositories
 */
export function invalidateRepositories(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: REPOSITORY_KEYS.all });
}

export function invalidateRepository(queryClient: ReturnType<typeof useQueryClient>, repoId: string) {
  return queryClient.invalidateQueries({ queryKey: REPOSITORY_KEYS.detail(repoId) });
}

export const ARCHITECTURE_KEYS = {
  detail: (repoId: string) => ['architecture', repoId] as const,
};

/**
 * Fetches and caches the architecture flow for a repository.
 * Stale time: 5 minutes.
 */
export function useArchitecture(repoId: string | null | undefined, initialData?: any) {
  return useQuery<ArchitectureFlow>({
    queryKey: repoId ? ARCHITECTURE_KEYS.detail(repoId) : (['architecture', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/repositories/${repoId}/architecture`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch architecture.');
      }
      return res.json();
    },
    enabled: Boolean(repoId),
    staleTime: 5 * 60 * 1000,
    initialData,
  });
}

export function invalidateArchitecture(queryClient: ReturnType<typeof useQueryClient>, repoId: string) {
  return queryClient.invalidateQueries({ queryKey: ARCHITECTURE_KEYS.detail(repoId) });
}

export const GRAPH_KEYS = {
  detail: (repoId: string) => ['graph', repoId] as const,
};

/**
 * Fetches and caches the code relationship graph for a repository.
 * Stale time: 5 minutes.
 */
export function useGraph(repoId: string | null | undefined) {
  return useQuery<GraphApiResponse>({
    queryKey: repoId ? GRAPH_KEYS.detail(repoId) : (['graph', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/repositories/${repoId}/graph`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch graph data.');
      }
      return res.json();
    },
    enabled: Boolean(repoId),
    staleTime: 5 * 60 * 1000,
  });
}

export function invalidateGraph(queryClient: ReturnType<typeof useQueryClient>, repoId: string) {
  return queryClient.invalidateQueries({ queryKey: GRAPH_KEYS.detail(repoId) });
}

export const FILES_KEYS = {
  tree: (repoId: string) => ['repository-files', repoId] as const,
  content: (repoId: string, path: string) => ['file-content', repoId, path] as const,
};

export interface RepositoryFilesResponse {
  fileTree: FileTreeNode;
  totalFiles: number;
  snippets: Record<string, { code: string; language: string; lineCount: number }>;
}

export interface SingleFileResponse {
  file: {
    id: string;
    filePath: string;
    fileName: string;
    extension: string;
    language: string;
    lineCount: number;
    code: string;
  };
}

/**
 * Fetches and caches the file tree structure and metadata for a repository.
 * Stale time: 5 minutes.
 */
export function useRepositoryFiles(repoId: string | null | undefined) {
  return useQuery<RepositoryFilesResponse>({
    queryKey: repoId ? FILES_KEYS.tree(repoId) : (['repository-files', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/repositories/${repoId}/files`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch repository files.');
      }
      return res.json();
    },
    enabled: Boolean(repoId),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Lazily fetches and caches individual file contents upon selection.
 * Stale time: 10 minutes.
 */
export function useFileContent(repoId: string | null | undefined, filePath: string | null | undefined) {
  return useQuery<SingleFileResponse>({
    queryKey: repoId && filePath ? FILES_KEYS.content(repoId, filePath) : (['file-content', 'null', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/repositories/${repoId}/files?path=${encodeURIComponent(filePath!)}`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch file content.');
      }
      return res.json();
    },
    enabled: Boolean(repoId && filePath),
    staleTime: 10 * 60 * 1000,
  });
}

export function invalidateRepositoryFiles(queryClient: ReturnType<typeof useQueryClient>, repoId: string) {
  return queryClient.invalidateQueries({ queryKey: FILES_KEYS.tree(repoId) });
}

export const PLAN_KEYS = {
  list: (repoId: string) => ['feature-plans', repoId] as const,
  detail: (repoId: string, planId: string) => ['feature-plan', repoId, planId] as const,
};

/**
 * Fetches and validates a specific feature plan by ID scoped to a repository.
 */
export function useValidatedPlan(repoId: string | null | undefined, planId: string | null | undefined) {
  return useQuery<{ plan: FeaturePlanRecord | null; notFound?: boolean }>({
    queryKey:
      repoId && planId
        ? PLAN_KEYS.detail(repoId, planId)
        : (['feature-plan', 'null', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(
        `/api/feature-plans/${encodeURIComponent(planId!)}?repositoryId=${encodeURIComponent(repoId!)}`
      );
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (res.status === 404) {
        return { plan: null, notFound: true };
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to validate feature plan.');
      }
      const data = await res.json();
      return { plan: data.plan || null, notFound: !data.plan };
    },
    enabled: Boolean(repoId && planId),
    retry: false,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Fetches and caches feature plans for a repository.
 * Stale time: 2 minutes.
 */
export function useFeaturePlans(repoId: string | null | undefined) {
  return useQuery<{ plans: FeaturePlanRecord[] }>({
    queryKey: repoId ? PLAN_KEYS.list(repoId) : (['feature-plans', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/repositories/${repoId}/feature-plans`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch feature plans.');
      }
      return res.json();
    },
    enabled: Boolean(repoId),
    staleTime: 2 * 60 * 1000,
  });
}

export function invalidateFeaturePlans(queryClient: ReturnType<typeof useQueryClient>, repoId: string) {
  return queryClient.invalidateQueries({ queryKey: PLAN_KEYS.list(repoId) });
}

export const CHANGESET_KEYS = {
  list: (planId: string) => ['changesets', planId] as const,
  detail: (repoId: string, planId: string | null | undefined, changesetId: string) =>
    ['changeset', repoId, planId || 'any', changesetId] as const,
};

/**
 * Fetches and validates a specific changeset by ID scoped to a repository (and optional plan).
 */
export function useValidatedChangeset(
  repoId: string | null | undefined,
  planId: string | null | undefined,
  changesetId: string | null | undefined
) {
  return useQuery<{ changeset: GeneratedChangeset | null; notFound?: boolean }>({
    queryKey:
      repoId && changesetId
        ? CHANGESET_KEYS.detail(repoId, planId, changesetId)
        : (['changeset', 'null', 'null', 'null'] as const),
    queryFn: async () => {
      const qs = new URLSearchParams({ repositoryId: repoId! });
      if (planId) qs.set('planId', planId);
      const res = await fetch(
        `/api/changesets/${encodeURIComponent(changesetId!)}?${qs.toString()}`
      );
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (res.status === 404) {
        return { changeset: null, notFound: true };
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to validate changeset.');
      }
      const data = await res.json();
      return { changeset: data.changeset || null, notFound: !data.changeset };
    },
    enabled: Boolean(repoId && changesetId),
    retry: false,
    staleTime: 2 * 60 * 1000,
  });
}

/**
 * Fetches and caches changesets for a feature plan.
 * Stale time: 2 minutes.
 */
export function useChangesets(planId: string | null | undefined) {
  return useQuery<{ changesets: GeneratedChangeset[] }>({
    queryKey: planId ? CHANGESET_KEYS.list(planId) : (['changesets', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/feature-plans/${planId}/changesets`);
      if (res.status === 401) {
        throw new Error('UNAUTHORIZED');
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch changesets.');
      }
      return res.json();
    },
    enabled: Boolean(planId),
    staleTime: 2 * 60 * 1000,
  });
}

export function invalidateChangesets(queryClient: ReturnType<typeof useQueryClient>, planId: string) {
  return queryClient.invalidateQueries({ queryKey: CHANGESET_KEYS.list(planId) });
}

export const GITHUB_KEYS = {
  connection: ['github-connection'] as const,
  branch: (changesetId: string) => ['changeset-branch', changesetId] as const,
  pr: (changesetId: string) => ['changeset-pr', changesetId] as const,
};

/**
 * Fetches and caches the GitHub connection status for the authenticated user.
 * Shared and deduplicated across all components.
 * Stale time: 5 minutes.
 */
export function useGitHubConnection() {
  return useQuery<GitHubConnectionStatus>({
    queryKey: GITHUB_KEYS.connection,
    queryFn: async () => {
      const res = await fetch('/api/github/connection');
      if (res.status === 401) {
        return { connected: false };
      }
      if (!res.ok) {
        return { connected: false };
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function invalidateGitHubConnection(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({ queryKey: GITHUB_KEYS.connection });
}

/**
 * Fetches and caches branch metadata for an approved changeset.
 * Stale time: 2 minutes.
 */
export function useChangesetBranch(changesetId: string | null | undefined) {
  return useQuery<{ branch: ChangesetBranch | null }>({
    queryKey: changesetId ? GITHUB_KEYS.branch(changesetId) : (['changeset-branch', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/changesets/${changesetId}/github/branch`);
      if (!res.ok) return { branch: null };
      return res.json();
    },
    enabled: Boolean(changesetId),
    staleTime: 2 * 60 * 1000,
  });
}

export function invalidateChangesetBranch(queryClient: ReturnType<typeof useQueryClient>, changesetId: string) {
  return queryClient.invalidateQueries({ queryKey: GITHUB_KEYS.branch(changesetId) });
}

/**
 * Fetches and caches PR metadata for a pushed changeset.
 * Stale time: 2 minutes.
 */
export function useChangesetPR(changesetId: string | null | undefined) {
  return useQuery<{ pullRequest: PullRequestRecord | null }>({
    queryKey: changesetId ? GITHUB_KEYS.pr(changesetId) : (['changeset-pr', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/changesets/${changesetId}/github/pr`);
      if (!res.ok) return { pullRequest: null };
      return res.json();
    },
    enabled: Boolean(changesetId),
    staleTime: 2 * 60 * 1000,
  });
}

export function invalidateChangesetPR(queryClient: ReturnType<typeof useQueryClient>, changesetId: string) {
  return queryClient.invalidateQueries({ queryKey: GITHUB_KEYS.pr(changesetId) });
}

export const VALIDATION_KEYS = {
  detail: (changesetId: string) => ['validation', changesetId] as const,
};

/**
 * Fetches and caches validation results for a changeset.
 * Stale time: 1 minute.
 */
export function useChangesetValidation(changesetId: string | null | undefined) {
  return useQuery<{ validation: ValidationResult | null }>({
    queryKey: changesetId ? VALIDATION_KEYS.detail(changesetId) : (['validation', 'null'] as const),
    queryFn: async () => {
      const res = await fetch(`/api/changesets/${changesetId}/validation`);
      if (!res.ok) return { validation: null };
      return res.json();
    },
    enabled: Boolean(changesetId),
    staleTime: 60 * 1000,
  });
}

export function invalidateValidation(queryClient: ReturnType<typeof useQueryClient>, changesetId: string) {
  return queryClient.invalidateQueries({ queryKey: VALIDATION_KEYS.detail(changesetId) });
}

export async function fetchRepositoryGitHubIssue(
  repoId: string,
  issueUrl: string
): Promise<GitHubIssueFetchResult> {
  const res = await fetch(`/api/repositories/${encodeURIComponent(repoId)}/github-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueUrl }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(data.error || 'UNAUTHORIZED');
  }
  if (!res.ok) {
    throw new Error(data.error || 'Failed to fetch GitHub issue.');
  }
  return data.issue as GitHubIssueFetchResult;
}




