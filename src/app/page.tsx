'use client';

import React, { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  useRepositories,
  useRepository,
  markRepositoryOpened,
  REPOSITORY_KEYS,
  invalidateRepositories,
  invalidateRepository,
  invalidateGraph,
  invalidateArchitecture,
  invalidateRepositoryFiles,
} from '@/lib/api/queries';
import { Repository, TabType, ArchitectureFlowNode, PlannerStep } from '@/types';

import { Navbar } from '@/components/layout/Navbar';
import { Sidebar } from '@/components/layout/Sidebar';
import { RightPanel } from '@/components/layout/RightPanel';
import { Dashboard } from '@/components/dashboard/Dashboard';

import { UploadModal } from '@/components/upload/UploadModal';
import { IndexingProgressModal } from '@/components/indexing/IndexingProgressModal';

import { RepositorySummaryView } from '@/components/summary/RepositorySummaryView';
import { DependencyGraphView, GraphPersistedUiState } from '@/components/graph/DependencyGraphView';
import { FileExplorerView, FilesPersistedUiState } from '@/components/files/FileExplorerView';
import { AnalysisView, AnalysisUrlUpdate } from '@/components/analysis/AnalysisView';

const VALID_TABS = new Set<TabType>(['summary', 'graph', 'files', 'analysis', 'settings']);
const VALID_PLANNER_STEPS = new Set<PlannerStep>(['issue', 'plan', 'changes', 'pr']);

function parseTabParam(rawTab: string | null): TabType {
  if (rawTab && VALID_TABS.has(rawTab as TabType)) {
    return rawTab as TabType;
  }
  return 'summary';
}

function parsePlannerStepParam(rawStep: string | null): PlannerStep | null {
  if (rawStep && VALID_PLANNER_STEPS.has(rawStep as PlannerStep)) {
    return rawStep as PlannerStep;
  }
  return null;
}

function buildRepoUrl(
  repoId: string,
  tab: TabType = 'summary',
  analysisParams?: { step?: PlannerStep | null; plan?: string | null; changeset?: string | null }
): string {
  const params = new URLSearchParams();
  params.set('repo', repoId);
  params.set('tab', tab);
  if (tab === 'analysis' && analysisParams) {
    if (analysisParams.step) params.set('step', analysisParams.step);
    if (analysisParams.plan) params.set('plan', analysisParams.plan);
    if (analysisParams.changeset) params.set('changeset', analysisParams.changeset);
  }
  return `/?${params.toString()}`;
}

function WorkspaceShellFallback() {
  return (
    <div className="bg-[#121316] text-[#e3e2e6] min-h-screen flex flex-col font-sans">
      <div className="h-14 border-b border-[#48454d]/20 bg-[#121316]/90 px-6 flex items-center">
        <div className="h-5 w-28 rounded bg-[#1f1f23] animate-pulse" />
      </div>
      <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-10 space-y-6">
        <div className="h-8 w-52 rounded-lg bg-[#1f1f23] animate-pulse" />
        <div className="h-44 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />
      </div>
    </div>
  );
}

function NodalWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const rawRepoParam = searchParams.get('repo');
  const urlRepoId = rawRepoParam && rawRepoParam.trim().length > 0 ? rawRepoParam.trim() : null;
  const activeTab = parseTabParam(searchParams.get('tab'));
  const urlAnalysisStep = parsePlannerStepParam(searchParams.get('step'));
  const urlPlanId = searchParams.get('plan')?.trim() || null;
  const urlChangesetId = searchParams.get('changeset')?.trim() || null;

  const { data: repositories = [], isLoading: loadingRepos, error: repoError } = useRepositories();
  const {
    data: fetchedRepo,
    isLoading: loadingRepoDetail,
    error: repoDetailError,
    refetch: refetchRepoDetail,
  } = useRepository(urlRepoId);

  const isRepoNotFound = Boolean(
    urlRepoId && (repoDetailError as Error | null)?.message === 'NOT_FOUND'
  );
  const isRepoFetchError = Boolean(
    urlRepoId &&
      repoDetailError &&
      (repoDetailError as Error).message !== 'NOT_FOUND' &&
      (repoDetailError as Error).message !== 'UNAUTHORIZED'
  );

  const listMatchedRepo = useMemo(
    () => (urlRepoId ? repositories.find((r) => r.id === urlRepoId) || null : null),
    [urlRepoId, repositories]
  );

  const activeRepo: Repository | null = useMemo(() => {
    if (!urlRepoId || isRepoNotFound) return null;
    return fetchedRepo || listMatchedRepo;
  }, [urlRepoId, isRepoNotFound, fetchedRepo, listMatchedRepo]);

  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const [fileSelectionState, setFileSelectionState] = useState<{
    repoId: string | null;
    selectedFile: string;
    targetLineRange: { startLine?: number; endLine?: number };
  }>({ repoId: null, selectedFile: '', targetLineRange: {} });
  const [layerFilterState, setLayerFilterState] = useState<{
    repoId: string | null;
    value: { label: string; count: number; files: string[] } | null;
  }>({ repoId: null, value: null });
  const [graphUiStateByRepo, setGraphUiStateByRepo] = useState<Record<string, GraphPersistedUiState>>({});
  const [filesUiStateByRepo, setFilesUiStateByRepo] = useState<Record<string, FilesPersistedUiState>>({});

  // Modals state
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadInitialTab, setUploadInitialTab] = useState<'zip' | 'github'>('zip');

  // Real Indexing progress polling state
  const [isIndexingModalOpen, setIsIndexingModalOpen] = useState(false);
  const [indexingRepoId, setIndexingRepoId] = useState<string | null>(null);
  const [indexingRepoName, setIndexingRepoName] = useState('');
  const [indexingStage, setIndexingStage] = useState('Pending Ingestion');
  const [indexingProgress, setIndexingProgress] = useState(0);
  const [indexingStatus, setIndexingStatus] = useState<string>('PENDING');
  const [indexingError, setIndexingError] = useState<string | undefined>(undefined);

  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Track last repo ID marked opened to avoid duplicate /open calls across tab switches
  const lastOpenedRepoRef = useRef<string | null>(null);

  // Global app history stack for back navigation across tabs and file views within a repo
  const [navHistoryState, setNavHistoryState] = useState<{
    repoId: string | null;
    items: {
      tab: TabType;
      selectedFile: string;
      targetLineRange: { startLine?: number; endLine?: number };
      activeLayerFilter: { label: string; count: number; files: string[] } | null;
      analysisParams?: {
        step?: PlannerStep | null;
        plan?: string | null;
        changeset?: string | null;
      };
    }[];
  }>({ repoId: null, items: [] });

  const selectedFile = fileSelectionState.repoId === urlRepoId ? fileSelectionState.selectedFile : '';
  const targetLineRange =
    fileSelectionState.repoId === urlRepoId ? fileSelectionState.targetLineRange : {};
  const activeLayerFilter = layerFilterState.repoId === urlRepoId ? layerFilterState.value : null;
  const navHistory = navHistoryState.repoId === urlRepoId ? navHistoryState.items : [];

  const pushNavHistory = () => {
    setNavHistoryState((prev) => {
      const currentItems = prev.repoId === urlRepoId ? prev.items : [];
      return {
        repoId: urlRepoId,
        items: [
          ...currentItems.slice(-29),
          {
            tab: activeTab,
            selectedFile,
            targetLineRange,
            activeLayerFilter,
            analysisParams:
              activeTab === 'analysis'
                ? { step: urlAnalysisStep, plan: urlPlanId, changeset: urlChangesetId }
                : undefined,
          },
        ],
      };
    });
  };

  const handleGoBack = () => {
    if (!urlRepoId || navHistory.length === 0) return;
    const nextHistory = [...navHistory];
    const previousSnapshot = nextHistory.pop()!;
    setNavHistoryState({ repoId: urlRepoId, items: nextHistory });
    setFileSelectionState({
      repoId: urlRepoId,
      selectedFile: previousSnapshot.selectedFile,
      targetLineRange: previousSnapshot.targetLineRange,
    });
    setLayerFilterState({ repoId: urlRepoId, value: previousSnapshot.activeLayerFilter });
    if (previousSnapshot.tab !== activeTab || previousSnapshot.analysisParams) {
      router.replace(
        buildRepoUrl(urlRepoId, previousSnapshot.tab, previousSnapshot.analysisParams),
        { scroll: false }
      );
    }
  };

  const handleTabChange = (newTab: TabType) => {
    if (!urlRepoId) return;
    if (newTab !== activeTab) {
      pushNavHistory();
      if (newTab !== 'files') {
        setLayerFilterState({ repoId: urlRepoId, value: null });
      }
      router.replace(buildRepoUrl(urlRepoId, newTab));
    }
  };

  // Redirect to login if authentication is missing or expired
  useEffect(() => {
    const isUnauthList = (repoError as Error | null)?.message === 'UNAUTHORIZED';
    const isUnauthDetail = (repoDetailError as Error | null)?.message === 'UNAUTHORIZED';
    if (isUnauthList || isUnauthDetail) {
      router.push('/login');
    }
  }, [repoError, repoDetailError, router]);

  // Persist last_opened_at once per repository navigation (including direct URL load)
  useEffect(() => {
    if (!urlRepoId) {
      lastOpenedRepoRef.current = null;
      return;
    }

    if (isRepoNotFound || fetchedRepo?.id !== urlRepoId) {
      return;
    }

    if (lastOpenedRepoRef.current === urlRepoId) {
      return;
    }

    lastOpenedRepoRef.current = urlRepoId;

    markRepositoryOpened(urlRepoId)
      .then(() => {
        invalidateRepositories(queryClient);
      })
      .catch((err) => {
        if (err?.message === 'UNAUTHORIZED') {
          router.push('/login');
        } else {
          console.error('Failed to persist repository last_opened_at:', err);
        }
      });
  }, [urlRepoId, fetchedRepo?.id, isRepoNotFound, queryClient, router]);

  // Poll backend for indexing progress
  useEffect(() => {
    if (!indexingRepoId || !isIndexingModalOpen) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/repositories/${encodeURIComponent(indexingRepoId)}`);
        if (res.ok) {
          const data = await res.json();
          const repo = data.repository;
          if (repo) {
            setIndexingStage(repo.stage || 'Processing');
            setIndexingProgress(repo.progress || 0);
            setIndexingStatus(repo.status);
            setIndexingError(repo.error_message);

            if (repo.status === 'COMPLETED' || repo.status === 'FAILED') {
              clearInterval(interval);
              invalidateRepositories(queryClient);
              if (repo.id) {
                invalidateRepository(queryClient, repo.id);
                invalidateGraph(queryClient, repo.id);
                invalidateArchitecture(queryClient, repo.id);
                invalidateRepositoryFiles(queryClient, repo.id);
              }
            }
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [indexingRepoId, isIndexingModalOpen, queryClient]);

  // Handle Real ZIP Upload
  const handleUploadZip = async (file: File) => {
    setIndexingRepoName(file.name.replace(/\.zip$/i, ''));
    setIndexingStage('Uploading ZIP archive...');
    setIndexingProgress(5);
    setIndexingStatus('PENDING');
    setIndexingError(undefined);
    setIsIndexingModalOpen(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', file.name.replace(/\.zip$/i, ''));

      const res = await fetch('/api/repositories', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to upload repository ZIP');
      }

      const data = await res.json();
      setIndexingRepoId(data.id);
      invalidateRepositories(queryClient);
    } catch (err: unknown) {
      setIndexingStatus('FAILED');
      setIndexingError(
        err instanceof Error ? err.message : 'Failed to upload repository ZIP.'
      );
    }
  };

  // Handle Real GitHub Import
  const handleImportGithub = async (url: string) => {
    setIndexingRepoName(url.split('/').pop() || url);
    setIndexingStage('Connecting to GitHub API...');
    setIndexingProgress(5);
    setIndexingStatus('PENDING');
    setIndexingError(undefined);
    setIsIndexingModalOpen(true);

    try {
      const res = await fetch('/api/repositories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubUrl: url }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to import GitHub repository');
      }

      const data = await res.json();
      setIndexingRepoId(data.id);
      invalidateRepositories(queryClient);
    } catch (err: unknown) {
      setIndexingStatus('FAILED');
      setIndexingError(
        err instanceof Error ? err.message : 'Failed to import GitHub repository.'
      );
    }
  };

  const handleFinishIndexing = () => {
    const newRepoId = indexingRepoId;
    setIsIndexingModalOpen(false);
    if (newRepoId) {
      router.push(buildRepoUrl(newRepoId, 'summary'));
    }
  };

  const handleDeleteRepo = async (repoId: string) => {
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(repoId)}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error('Failed to delete repository');
      }
      await invalidateRepositories(queryClient);
      queryClient.removeQueries({ queryKey: REPOSITORY_KEYS.detail(repoId) });
      if (urlRepoId === repoId) {
        lastOpenedRepoRef.current = null;
        router.replace('/');
      }
    } catch (err) {
      console.error('Delete repository error:', err);
      alert('Failed to delete repository. Please try again.');
    }
  };

  const handleSelectFileFromAnywhere = (filename: string, startLine?: number, endLine?: number) => {
    if (!urlRepoId) return;
    pushNavHistory();
    setFileSelectionState({
      repoId: urlRepoId,
      selectedFile: filename,
      targetLineRange: startLine && endLine ? { startLine, endLine } : {},
    });
    if (activeTab !== 'files') {
      router.replace(buildRepoUrl(urlRepoId, 'files'));
    }
  };

  const handleNavigateToArchitectureLayer = (node: ArchitectureFlowNode) => {
    if (!urlRepoId) return;
    pushNavHistory();
    setLayerFilterState({
      repoId: urlRepoId,
      value: {
        label: node.label,
        count: node.files.length,
        files: node.files,
      },
    });

    const primaryRef = node.references?.[0];
    const primaryFile = primaryRef?.filePath || node.files[0] || '';

    if (primaryFile) {
      setFileSelectionState({
        repoId: urlRepoId,
        selectedFile: primaryFile,
        targetLineRange:
          primaryRef?.startLine && primaryRef?.endLine
            ? { startLine: primaryRef.startLine, endLine: primaryRef.endLine }
            : {},
      });
    }

    if (activeTab !== 'files') {
      router.replace(buildRepoUrl(urlRepoId, 'files'));
    }
  };

  const handleAskAiFromAnywhere = () => {
    setIsRightPanelOpen(true);
  };

  const activeRepoId = activeRepo?.id;

  const handlePersistGraphUiState = useCallback(
    (state: GraphPersistedUiState) => {
      if (!activeRepoId) return;
      setGraphUiStateByRepo((prev) => {
        const existing = prev[activeRepoId];
        if (
          existing?.selectedNodeId === state.selectedNodeId &&
          existing?.layoutDirection === state.layoutDirection &&
          existing?.filterState === state.filterState &&
          existing?.focusState === state.focusState &&
          existing?.hierarchyState === state.hierarchyState
        ) {
          return prev;
        }
        return { ...prev, [activeRepoId]: state };
      });
    },
    [activeRepoId]
  );

  const handlePersistFilesUiState = useCallback(
    (state: FilesPersistedUiState) => {
      if (!activeRepoId) return;
      setFilesUiStateByRepo((prev) => {
        const existing = prev[activeRepoId];
        if (
          existing?.activeTab === state.activeTab &&
          existing?.openTabs === state.openTabs &&
          existing?.expandedFolders === state.expandedFolders
        ) {
          return prev;
        }
        return { ...prev, [activeRepoId]: state };
      });
    },
    [activeRepoId]
  );

  const handleSyncAnalysisUrl = useCallback(
    (next: AnalysisUrlUpdate) => {
      if (!urlRepoId) return;
      const targetUrl = buildRepoUrl(urlRepoId, 'analysis', {
        step: next.step !== undefined ? next.step : urlAnalysisStep,
        plan: next.plan !== undefined ? next.plan : urlPlanId,
        changeset: next.changeset !== undefined ? next.changeset : urlChangesetId,
      });
      router.replace(targetUrl, { scroll: false });
    },
    [urlRepoId, urlAnalysisStep, urlPlanId, urlChangesetId, router]
  );

  return (
    <div className="bg-[#121316] text-[#e3e2e6] min-h-screen flex flex-col font-sans selection:bg-[#fbcfe8]/20 selection:text-[#fbcfe8]">
      {/* Top Fixed Header */}
      <Navbar
        repositories={repositories}
        activeRepo={activeRepo}
        onSelectRepo={(repo) => {
          router.push(buildRepoUrl(repo.id, 'summary'));
        }}
        onOpenUploadModal={() => {
          setUploadInitialTab('zip');
          setIsUploadModalOpen(true);
        }}
        onNavigateHome={() => {
          setNavHistoryState({ repoId: null, items: [] });
        }}
        canGoBack={Boolean(urlRepoId && navHistory.length > 0)}
        onGoBack={urlRepoId ? handleGoBack : undefined}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onDeleteRepo={handleDeleteRepo}
      />

      {/* Main Content */}
      {!urlRepoId ? (
        <main className="flex-1 pt-14 w-full">
          <Dashboard
            repositories={repositories}
            isLoading={loadingRepos}
            onOpenUploadModal={() => {
              setUploadInitialTab('zip');
              setIsUploadModalOpen(true);
            }}
          />
        </main>
      ) : isRepoNotFound ? (
        <main className="flex-1 pt-14 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl bg-[#1a1b1e] border border-[#48454d]/25 p-8 text-center shadow-xl space-y-5">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-[#292a2d] border border-[#fbcfe8]/20 flex items-center justify-center text-[#fbcfe8]">
              <span className="material-symbols-outlined text-[28px]">folder_off</span>
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-heading font-semibold text-[#e3e2e6]">
                Repository not found
              </h1>
              <p className="text-xs text-[#938f98] leading-relaxed">
                This repository does not exist or you don&apos;t have access to view it.
              </p>
            </div>
            <Link
              href="/"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-sm font-semibold transition-colors shadow-sm"
            >
              <span className="material-symbols-outlined text-[18px]">arrow_back</span>
              <span>Back to Dashboard</span>
            </Link>
          </div>
        </main>
      ) : !activeRepo && loadingRepoDetail ? (
        <main className="flex-1 pt-14 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-4xl space-y-6">
            <div className="h-8 w-56 rounded-lg bg-[#1f1f23] animate-pulse" />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="h-32 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />
              <div className="h-32 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />
              <div className="h-32 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />
            </div>
            <div className="h-64 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />
          </div>
        </main>
      ) : !activeRepo && isRepoFetchError ? (
        <main className="flex-1 pt-14 flex items-center justify-center px-4 py-12">
          <div className="w-full max-w-md rounded-2xl bg-[#1a1b1e] border border-[#48454d]/25 p-8 text-center shadow-xl space-y-5">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-[#292a2d] border border-red-500/25 flex items-center justify-center text-red-400">
              <span className="material-symbols-outlined text-[28px]">error</span>
            </div>
            <div className="space-y-1.5">
              <h1 className="text-xl font-heading font-semibold text-[#e3e2e6]">
                Could not load repository
              </h1>
              <p className="text-xs text-[#938f98] leading-relaxed">
                {(repoDetailError as Error)?.message || 'An unexpected error occurred.'}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => refetchRepoDetail()}
                className="w-full sm:w-auto px-4 py-2 rounded-xl bg-[#1f1f23] hover:bg-[#292a2d] border border-[#48454d]/30 text-sm font-medium text-[#e3e2e6] cursor-pointer transition-colors"
              >
                Try Again
              </button>
              <Link
                href="/"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-sm font-semibold transition-colors"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </main>
      ) : activeRepo ? (
        /* Fixed Shell Workspace Layout */
        <div className="flex-1 flex w-full relative">
          {/* Left Sidebar Fixed 260px */}
          <Sidebar
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onOpenUploadModal={() => {
              setUploadInitialTab('zip');
              setIsUploadModalOpen(true);
            }}
            onNewChat={() => {
              setIsRightPanelOpen(true);
            }}
          />

          {/* Center Scrollable Content with fixed left and dynamic right padding */}
          <main
            className={`flex-1 min-w-0 pl-[260px] ${
              isRightPanelOpen ? 'pr-[320px]' : 'pr-0'
            } pt-14 flex flex-col transition-all duration-200 ${
              activeTab === 'graph'
                ? 'h-[calc(100vh-3.5rem)] p-2 items-stretch overflow-hidden'
                : 'items-center overflow-y-auto'
            }`}
          >
            <div
              className={`w-full ${
                activeTab === 'graph'
                  ? 'h-full flex-1 flex flex-col'
                  : 'max-w-5xl px-6 py-7'
              }`}
            >
              {activeTab === 'summary' && (
                <RepositorySummaryView
                  repo={activeRepo}
                  onNavigateToGraph={() => handleTabChange('graph')}
                  onNavigateToFiles={() => {
                    if (urlRepoId) {
                      setLayerFilterState({ repoId: urlRepoId, value: null });
                    }
                    handleTabChange('files');
                  }}
                  onNavigateToArchitectureNode={handleNavigateToArchitectureLayer}
                  onAskQuestion={handleAskAiFromAnywhere}
                  onDeleteRepo={handleDeleteRepo}
                />
              )}

              {activeTab === 'graph' && (
                <DependencyGraphView
                  repo={activeRepo}
                  persistedUiState={activeRepo?.id ? graphUiStateByRepo[activeRepo.id] : undefined}
                  onPersistUiState={handlePersistGraphUiState}
                  onSelectFile={handleSelectFileFromAnywhere}
                  onAskAi={handleAskAiFromAnywhere}
                />
              )}

              {activeTab === 'files' && (
                <FileExplorerView
                  repo={activeRepo}
                  selectedFile={selectedFile}
                  targetLineRange={targetLineRange}
                  activeLayerFilter={activeLayerFilter}
                  onClearFilter={() => {
                    if (urlRepoId) {
                      setLayerFilterState({ repoId: urlRepoId, value: null });
                    }
                  }}
                  onFileSelect={handleSelectFileFromAnywhere}
                  onAskAi={handleAskAiFromAnywhere}
                  persistedUiState={activeRepo?.id ? filesUiStateByRepo[activeRepo.id] : undefined}
                  onPersistUiState={handlePersistFilesUiState}
                />
              )}

              {activeTab === 'analysis' && (
                <AnalysisView
                  repo={activeRepo}
                  urlStep={urlAnalysisStep}
                  urlPlanId={urlPlanId}
                  urlChangesetId={urlChangesetId}
                  onSyncAnalysisUrl={handleSyncAnalysisUrl}
                  onSelectFile={handleSelectFileFromAnywhere}
                  onAskAi={handleAskAiFromAnywhere}
                />
              )}

              {activeTab === 'settings' && (
                <div className="space-y-6 max-w-2xl">
                  <h1 className="text-xl font-heading font-semibold text-[#e3e2e6]">Settings</h1>
                  <div className="p-4 rounded-xl bg-[#1a1b1e] border border-[#48454d]/25 space-y-3">
                    <span className="font-semibold text-xs text-[#e3e2e6] block">Database &amp; Vector Storage</span>
                    <p className="text-xs text-[#938f98]">
                      Connected to PostgreSQL + <span className="font-mono text-[#fbcfe8]">pgvector</span> vector store
                    </p>
                    <div className="pt-2">
                      <span className="text-[11px] font-mono text-[#b7c8e1] bg-[#121316] px-2.5 py-1 rounded border border-[#48454d]/20 inline-block">
                        Model: OpenAI text-embedding-3-small (1536 dims)
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>

          {/* Right Assistant Panel Fixed 320px */}
          <RightPanel
            activeRepo={activeRepo}
            isOpen={isRightPanelOpen}
            onClose={() => setIsRightPanelOpen(false)}
            onSelectFile={handleSelectFileFromAnywhere}
          />
        </div>
      ) : null}

      {/* Upload Modal (ZIP & GitHub) */}
      <UploadModal
        isOpen={isUploadModalOpen}
        onClose={() => setIsUploadModalOpen(false)}
        onUploadZip={handleUploadZip}
        onImportGithub={handleImportGithub}
        initialTab={uploadInitialTab}
      />

      {/* Indexing Progress Modal */}
      <IndexingProgressModal
        isOpen={isIndexingModalOpen}
        repoName={indexingRepoName}
        stage={indexingStage}
        progress={indexingProgress}
        status={indexingStatus}
        errorMessage={indexingError}
        onFinish={handleFinishIndexing}
        onClose={() => setIsIndexingModalOpen(false)}
      />
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<WorkspaceShellFallback />}>
      <NodalWorkspace />
    </Suspense>
  );
}
