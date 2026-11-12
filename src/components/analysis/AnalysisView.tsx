'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  Repository,
  FeaturePlanRecord,
  FeaturePlanData,
  GeneratedChangeset,
  PlannerStep,
  ContributorFileToChange,
  PlanEvidenceItem,
} from '@/types';
import { useQueryClient } from '@tanstack/react-query';
import {
  useFeaturePlans,
  useValidatedPlan,
  useChangesets,
  useValidatedChangeset,
  invalidateFeaturePlans,
  invalidateChangesets,
  fetchRepositoryGitHubIssue,
} from '@/lib/api/queries';
import { DiffViewer } from './DiffViewer';

export interface AnalysisPersistedUiState {
  step?: PlannerStep;
  selectedPlanId?: string | null;
  selectedChangesetId?: string | null;
}

export interface AnalysisUrlUpdate {
  step?: PlannerStep | null;
  plan?: string | null;
  changeset?: string | null;
}

export interface AnalysisViewProps {
  repo: Repository;
  urlStep?: PlannerStep | null;
  urlPlanId?: string | null;
  urlChangesetId?: string | null;
  onSyncAnalysisUrl?: (next: AnalysisUrlUpdate) => void;
  onSelectFile?: (filename: string, startLine?: number, endLine?: number) => void;
  onAskAi?: (prompt: string) => void;
  // Kept optional for backwards call compatibility
  persistedUiState?: AnalysisPersistedUiState;
  onPersistUiState?: (state: AnalysisPersistedUiState) => void;
}

const LOADING_STAGES = [
  'Scanning repository files and symbols...',
  'Running hybrid filename, AST & semantic retrieval...',
  'Inspecting matched source files...',
  'Drafting concrete contributor plan...',
];

const CODE_GEN_STAGES = [
  'Reading contributor implementation plan...',
  'Loading full source files from repository...',
  'Resolving AST symbol relationships...',
  'Generating minimal, targeted code changes...',
  'Preparing Git-style diff preview...',
];

interface NormalizedContributorPlan {
  issueType: 'bug' | 'feature';
  understanding: string;
  likelyCause: {
    summary: string;
    filePath: string;
    symbolOrFunction: string;
    lineRange?: string;
  } | null;
  filesToChange: ContributorFileToChange[];
  steps: Array<{
    step: number;
    action: string;
    targetFile?: string;
    symbols: string[];
  }>;
  howToTest: string[];
  risks: string[];
  retrievalConfidence: 'high' | 'medium' | 'low';
  confidenceNote?: string;
  evidenceUsed: PlanEvidenceItem[];
  chunkCount: number;
}

function normalizePlanForDisplay(plan: FeaturePlanData): NormalizedContributorPlan {
  const understanding = (plan.understanding || plan.overview || '').trim();
  const issueType: 'bug' | 'feature' = plan.issueType === 'bug' ? 'bug' : 'feature';
  const likelyCause =
    issueType === 'bug' &&
    plan.likelyCause &&
    plan.likelyCause.summary &&
    plan.likelyCause.filePath
      ? plan.likelyCause
      : null;

  let filesToChange: ContributorFileToChange[] = [];
  if (Array.isArray(plan.filesToChange) && plan.filesToChange.length > 0) {
    filesToChange = plan.filesToChange.filter((f) => f && f.filePath && f.reason);
  } else {
    const mods: ContributorFileToChange[] = (plan.filesToModify || [])
      .filter((f) => f?.filePath)
      .map((f) => ({
        filePath: f.filePath,
        changeType: 'modify',
        symbolOrLines: f.existingReference || (f.symbols || []).join(', '),
        reason: f.reason,
      }));
    const news: ContributorFileToChange[] = (plan.filesToCreate || [])
      .filter((f) => f?.filePath)
      .map((f) => ({
        filePath: f.filePath,
        changeType: 'create',
        symbolOrLines: 'New file',
        reason: f.purpose,
      }));
    filesToChange = [...mods, ...news];
  }

  const steps =
    Array.isArray(plan.steps) && plan.steps.length > 0
      ? plan.steps.map((s, idx) => ({
          step: s.step ?? idx + 1,
          action: s.action,
          targetFile: s.targetFile,
          symbols: s.symbols || [],
        }))
      : (plan.implementationSteps || []).map((s, idx) => ({
          step: s.step ?? idx + 1,
          action: s.description || s.title || '',
          targetFile: s.files?.[0],
          symbols: s.symbols || [],
        })).filter((s) => s.action.length > 0);

  const howToTest = Array.isArray(plan.howToTest) ? plan.howToTest.filter(Boolean) : [];
  const risks =
    Array.isArray(plan.risks) && plan.risks.length > 0
      ? plan.risks.filter(Boolean)
      : (plan.potentialSideEffects || []).filter(Boolean);

  const evidenceUsed: PlanEvidenceItem[] =
    Array.isArray(plan.evidenceUsed) && plan.evidenceUsed.length > 0
      ? plan.evidenceUsed
      : (plan.evidence?.files || []).map((filePath) => ({
          filePath,
          symbols: [],
          matchSource: 'semantic' as const,
        }));

  return {
    issueType,
    understanding,
    likelyCause,
    filesToChange,
    steps,
    howToTest,
    risks,
    retrievalConfidence: plan.retrievalConfidence || 'medium',
    confidenceNote: plan.confidenceNote,
    evidenceUsed,
    chunkCount: plan.evidence?.chunkCount || 0,
  };
}

export const AnalysisView: React.FC<AnalysisViewProps> = ({
  repo,
  urlStep,
  urlPlanId,
  urlChangesetId,
  onSyncAnalysisUrl,
  onSelectFile,
}) => {
  const queryClient = useQueryClient();

  const hasGitHubUpstream = repo.sourceType === 'github' && Boolean(repo.url);

  // Issue input state
  const [issueUrlInput, setIssueUrlInput] = useState('');
  const [issueText, setIssueText] = useState('');
  const [fetchedIssueMeta, setFetchedIssueMeta] = useState<{
    issueUrl: string;
    issueNumber: number;
    issueTitle: string;
    repoMismatchWarning?: string | null;
  } | null>(null);
  const [isFetchingIssue, setIsFetchingIssue] = useState(false);
  const [issueFetchError, setIssueFetchError] = useState<string | null>(null);

  // Async action states
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [loadingStageIdx, setLoadingStageIdx] = useState(0);
  const [codeGenStageIdx, setCodeGenStageIdx] = useState(0);
  const [planError, setPlanError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [codeGenError, setCodeGenError] = useState<string | null>(null);
  const [urlValidationNotice, setUrlValidationNotice] = useState<string | null>(null);
  const [isEvidenceExpanded, setIsEvidenceExpanded] = useState(false);

  // Previous plans list
  const { data: plansData } = useFeaturePlans(repo.id);
  const previousPlans = useMemo(() => plansData?.plans || [], [plansData?.plans]);

  // Server-side validation for ?plan= URL parameter
  const {
    data: validatedPlanRes,
    isLoading: validatingUrlPlan,
  } = useValidatedPlan(repo.id, urlPlanId);

  const currentPlan: FeaturePlanRecord | null = useMemo(() => {
    if (urlPlanId) {
      if (validatedPlanRes?.notFound) return null;
      return (
        validatedPlanRes?.plan ||
        previousPlans.find((p) => p.id === urlPlanId) ||
        null
      );
    }
    return null;
  }, [urlPlanId, validatedPlanRes, previousPlans]);

  // Changesets for current plan
  const { data: changesetsData } = useChangesets(currentPlan?.id);
  const allChangesets = useMemo(() => changesetsData?.changesets || [], [changesetsData?.changesets]);

  // Server-side validation for ?changeset= URL parameter
  const {
    data: validatedChangesetRes,
    isLoading: validatingUrlChangeset,
  } = useValidatedChangeset(repo.id, currentPlan?.id || urlPlanId, urlChangesetId);

  const currentChangeset: GeneratedChangeset | null = useMemo(() => {
    if (urlChangesetId) {
      if (validatedChangesetRes?.notFound) return null;
      return (
        validatedChangesetRes?.changeset ||
        allChangesets.find((c) => c.id === urlChangesetId) ||
        null
      );
    }
    return allChangesets[0] || null;
  }, [urlChangesetId, validatedChangesetRes, allChangesets]);

  // Clean up invalid URL params once server validation rejects them
  useEffect(() => {
    if (urlPlanId && validatedPlanRes?.notFound) {
      queueMicrotask(() => {
        setUrlValidationNotice(
          'The referenced plan does not exist for this repository or you do not have access to view it.'
        );
      });
      onSyncAnalysisUrl?.({ step: 'issue', plan: null, changeset: null });
    }
  }, [urlPlanId, validatedPlanRes?.notFound, onSyncAnalysisUrl]);

  useEffect(() => {
    if (urlChangesetId && validatedChangesetRes?.notFound) {
      queueMicrotask(() => {
        setUrlValidationNotice(
          'The referenced changeset does not exist for this plan or repository.'
        );
      });
      onSyncAnalysisUrl?.({
        step: currentPlan ? 'plan' : 'issue',
        plan: currentPlan?.id || null,
        changeset: null,
      });
    }
  }, [urlChangesetId, validatedChangesetRes?.notFound, currentPlan, onSyncAnalysisUrl]);

  // Determine effective step cleanly without bouncing while validating URL params on refresh
  const activeStep: PlannerStep = useMemo(() => {
    if (urlStep === 'pr') {
      if (!hasGitHubUpstream) return currentChangeset ? 'changes' : currentPlan ? 'plan' : 'issue';
      if (currentChangeset || validatingUrlChangeset) return 'pr';
      if (currentPlan || validatingUrlPlan) return 'plan';
      return 'issue';
    }
    if (urlStep === 'changes') {
      if (currentChangeset || validatingUrlChangeset || (urlPlanId && !validatedPlanRes?.notFound)) {
        return 'changes';
      }
      return currentPlan ? 'plan' : 'issue';
    }
    if (urlStep === 'plan') {
      if (currentPlan || validatingUrlPlan || (urlPlanId && !validatedPlanRes?.notFound)) {
        return 'plan';
      }
      return 'issue';
    }
    if (urlStep === 'issue') return 'issue';
    if (urlChangesetId && !validatedChangesetRes?.notFound) return 'changes';
    if (urlPlanId && !validatedPlanRes?.notFound) return 'plan';
    return 'issue';
  }, [
    urlStep,
    urlPlanId,
    urlChangesetId,
    hasGitHubUpstream,
    currentPlan,
    currentChangeset,
    validatingUrlPlan,
    validatingUrlChangeset,
    validatedPlanRes?.notFound,
    validatedChangesetRes?.notFound,
  ]);

  // Plan loading ticker
  useEffect(() => {
    if (!isGeneratingPlan) return;
    const interval = setInterval(() => {
      setLoadingStageIdx((prev) => (prev + 1) % LOADING_STAGES.length);
    }, 2600);
    return () => clearInterval(interval);
  }, [isGeneratingPlan]);

  // CodeGen loading ticker
  useEffect(() => {
    if (!isGeneratingCode) return;
    const interval = setInterval(() => {
      setCodeGenStageIdx((prev) => (prev + 1) % CODE_GEN_STAGES.length);
    }, 2600);
    return () => clearInterval(interval);
  }, [isGeneratingCode]);

  const handleFetchGitHubIssue = async () => {
    const trimmed = issueUrlInput.trim();
    if (!trimmed) {
      setIssueFetchError('Paste a GitHub issue URL (e.g. https://github.com/owner/repo/issues/123).');
      return;
    }

    setIsFetchingIssue(true);
    setIssueFetchError(null);
    setUrlValidationNotice(null);

    try {
      const issue = await fetchRepositoryGitHubIssue(repo.id, trimmed);
      setFetchedIssueMeta({
        issueUrl: issue.issueUrl,
        issueNumber: issue.issueNumber,
        issueTitle: issue.title,
        repoMismatchWarning: issue.repoMismatchWarning || null,
      });

      const formattedBody = issue.body?.trim()
        ? `${issue.title}\n\n${issue.body.trim()}`
        : issue.title;
      setIssueText(formattedBody);
      setIssueUrlInput(issue.issueUrl);
    } catch (err: any) {
      setIssueFetchError(err?.message || 'Failed to fetch GitHub issue.');
    } finally {
      setIsFetchingIssue(false);
    }
  };

  const handleGeneratePlan = async (overrideText?: string) => {
    const text = (overrideText ?? issueText).trim();
    if (!text) {
      setPlanError({ message: 'Please paste an issue description or fetch a GitHub issue first.', retryable: false });
      return;
    }

    setIsGeneratingPlan(true);
    setPlanError(null);
    setCodeGenError(null);
    setUrlValidationNotice(null);
    setLoadingStageIdx(0);

    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(repo.id)}/feature-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feature: text,
          issueUrl: fetchedIssueMeta?.issueUrl || (issueUrlInput.trim() || undefined),
          issueTitle: fetchedIssueMeta?.issueTitle || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPlanError({
          message: data.error || 'Failed to generate implementation plan.',
          retryable: data.retryable !== false,
        });
        return;
      }

      if (data.plan) {
        await invalidateFeaturePlans(queryClient, repo.id);
        onSyncAnalysisUrl?.({
          step: 'plan',
          plan: data.plan.id,
          changeset: null,
        });
      }
    } catch (err: any) {
      setPlanError({
        message: err?.message || 'Network error while generating plan.',
        retryable: true,
      });
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  const handleImplementPlan = async () => {
    if (!currentPlan) return;
    setIsGeneratingCode(true);
    setCodeGenError(null);
    setCodeGenStageIdx(0);

    try {
      const res = await fetch(
        `/api/feature-plans/${encodeURIComponent(currentPlan.id)}/generate-changes`,
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate code changes.');
      }

      if (data.changeset) {
        await invalidateChangesets(queryClient, currentPlan.id);
        onSyncAnalysisUrl?.({
          step: 'changes',
          plan: currentPlan.id,
          changeset: data.changeset.id,
        });
      }
    } catch (err: any) {
      setCodeGenError(err?.message || 'An error occurred while generating code changes.');
    } finally {
      setIsGeneratingCode(false);
    }
  };

  const handleApproveChangeset = async (changesetId: string) => {
    try {
      const res = await fetch(`/api/changesets/${encodeURIComponent(changesetId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      });
      if (res.ok && currentPlan) {
        invalidateChangesets(queryClient, currentPlan.id);
      }
    } catch (err) {
      console.error('Error approving changeset:', err);
    }
  };

  const handleRejectChangeset = async (changesetId: string) => {
    try {
      const res = await fetch(`/api/changesets/${encodeURIComponent(changesetId)}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' }),
      });
      if (res.ok && currentPlan) {
        invalidateChangesets(queryClient, currentPlan.id);
      }
    } catch (err) {
      console.error('Error rejecting changeset:', err);
    }
  };

  const normalizedPlan = useMemo(
    () => (currentPlan?.planJson ? normalizePlanForDisplay(currentPlan.planJson) : null),
    [currentPlan]
  );

  const stepsMeta: Array<{
    id: PlannerStep;
    number: number;
    label: string;
    enabled: boolean;
    disabledReason?: string;
  }> = [
    { id: 'issue', number: 1, label: 'Issue', enabled: true },
    {
      id: 'plan',
      number: 2,
      label: 'Plan',
      enabled: Boolean(currentPlan),
      disabledReason: 'Generate or select a plan first',
    },
    {
      id: 'changes',
      number: 3,
      label: 'Code changes',
      enabled: Boolean(currentChangeset),
      disabledReason: 'Click "Implement plan" to generate code changes',
    },
    {
      id: 'pr',
      number: 4,
      label: 'Pull request',
      enabled: Boolean(hasGitHubUpstream && currentChangeset),
      disabledReason: !hasGitHubUpstream
        ? 'Disabled for ZIP uploads (no GitHub upstream)'
        : 'Generate and review code changes first',
    },
  ];

  const isRestoringPlanFromUrl = Boolean(urlPlanId && !currentPlan && validatingUrlPlan);
  const isRestoringChangesetFromUrl = Boolean(
    urlChangesetId && !currentChangeset && validatingUrlChangeset
  );

  return (
    <div className="flex flex-col w-full gap-6 max-w-5xl pb-16 animate-in fade-in duration-200">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#241c2c] border border-[#fbcfe8]/40 flex items-center justify-center text-[#fbcfe8] shadow-lg shadow-[#fbcfe8]/10">
            <span className="material-symbols-outlined text-[22px]">architecture</span>
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-heading font-bold text-white tracking-tight">
              AI Contributor Planner
            </h1>
            <p className="text-xs text-[#938f98]">
              Turn a GitHub issue or problem description into a codebase-grounded plan and PR.
            </p>
          </div>
        </div>

        {/* Previous Plans Switcher */}
        {previousPlans.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-[#938f98] shrink-0">History:</span>
            <select
              value={currentPlan?.id || ''}
              onChange={(e) => {
                const chosenId = e.target.value;
                if (!chosenId) return;
                setUrlValidationNotice(null);
                onSyncAnalysisUrl?.({
                  step: 'plan',
                  plan: chosenId,
                  changeset: null,
                });
              }}
              className="bg-[#1a1b1e] border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] rounded-xl px-3 py-1.5 max-w-[260px] focus:outline-none focus:border-[#fbcfe8]/60 cursor-pointer"
            >
              {!currentPlan && <option value="">Select a previous plan...</option>}
              {previousPlans.map((p) => {
                const label = p.issueNumber
                  ? `#${p.issueNumber} ${p.issueTitle || p.featureRequest}`
                  : p.featureRequest;
                return (
                  <option key={p.id} value={p.id}>
                    {label.slice(0, 44)}
                    {label.length > 44 ? '…' : ''} ({new Date(p.createdAt).toLocaleDateString()})
                  </option>
                );
              })}
            </select>
          </div>
        )}
      </header>

      {/* 4-Step Workflow Stepper */}
      <nav
        aria-label="Contributor planner workflow"
        className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-[#13151b]/95 border border-[#48454d]/30 rounded-2xl p-2 shadow-lg"
      >
        {stepsMeta.map((step) => {
          const isActive = activeStep === step.id;
          return (
            <button
              key={step.id}
              type="button"
              disabled={!step.enabled}
              title={step.enabled ? step.label : step.disabledReason}
              onClick={() => {
                if (!step.enabled) return;
                onSyncAnalysisUrl?.({
                  step: step.id,
                  plan: currentPlan?.id || null,
                  changeset:
                    step.id === 'changes' || step.id === 'pr'
                      ? currentChangeset?.id || null
                      : step.id === 'plan'
                      ? urlChangesetId || null
                      : null,
                });
              }}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all ${
                isActive
                  ? 'bg-[#241c2c] border border-[#fbcfe8]/45 text-white shadow-sm'
                  : step.enabled
                  ? 'bg-[#1a1b1e]/70 hover:bg-[#23252c] border border-transparent text-[#cac5ce] cursor-pointer'
                  : 'bg-transparent border border-transparent text-[#6a6770] opacity-60 cursor-not-allowed'
              }`}
            >
              <span
                className={`w-6 h-6 rounded-full text-[11px] font-mono font-bold flex items-center justify-center shrink-0 ${
                  isActive
                    ? 'bg-[#fbcfe8] text-[#3d1729]'
                    : step.enabled
                    ? 'bg-[#292a2d] text-[#cac5ce]'
                    : 'bg-[#1a1b1e] text-[#6a6770]'
                }`}
              >
                {step.number}
              </span>
              <span className="text-xs font-mono font-semibold truncate">{step.label}</span>
            </button>
          );
        })}
      </nav>

      {/* ZIP repository banner notice when no GitHub upstream exists */}
      {!hasGitHubUpstream && (
        <div className="px-4 py-2.5 rounded-xl bg-[#1a1b1e] border border-[#48454d]/35 text-[#938f98] text-xs font-mono flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[17px] text-[#b7c8e1] shrink-0">
            folder_zip
          </span>
          <span>
            This repository was uploaded as a ZIP archive (no GitHub upstream). You can plan and inspect code changes here, while <strong className="text-[#e3e2e6]">Create PR</strong> is disabled.
          </span>
        </div>
      )}

      {/* Server URL param validation alert */}
      {urlValidationNotice && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[17px] text-amber-300 shrink-0">info</span>
            <span>{urlValidationNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setUrlValidationNotice(null)}
            className="text-amber-300 hover:text-white cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">close</span>
          </button>
        </div>
      )}

      {/* URL-restoration loading skeleton */}
      {(isRestoringPlanFromUrl || isRestoringChangesetFromUrl) && (
        <section className="bg-[#13151b]/90 border border-[#48454d]/30 rounded-3xl p-8 space-y-4">
          <div className="h-5 w-48 bg-[#1f1f23] rounded animate-pulse" />
          <div className="h-24 w-full bg-[#1a1b1e] rounded-2xl animate-pulse" />
        </section>
      )}

      {/* STEP 1: ISSUE INPUT */}
      {activeStep === 'issue' && !isRestoringPlanFromUrl && (
        <section className="bg-[#13151b]/95 backdrop-blur-xl border border-[#48454d]/35 rounded-3xl p-6 shadow-2xl space-y-5">
          {/* Optional GitHub Issue URL field */}
          <div className="space-y-1.5">
            <label className="text-xs font-mono font-medium text-[#cac5ce] uppercase tracking-wider flex items-center justify-between">
              <span>GitHub Issue URL (Optional)</span>
              {repo.url && (
                <span className="text-[10px] text-[#938f98] normal-case">
                  Indexed source: {repo.fullName}
                </span>
              )}
            </label>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="url"
                value={issueUrlInput}
                onChange={(e) => setIssueUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleFetchGitHubIssue();
                  }
                }}
                placeholder="https://github.com/owner/repo/issues/123"
                disabled={isFetchingIssue || isGeneratingPlan}
                className="flex-1 bg-[#1c1e26] border border-[#48454d]/40 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none font-mono"
              />
              <button
                type="button"
                onClick={handleFetchGitHubIssue}
                disabled={isFetchingIssue || isGeneratingPlan || !issueUrlInput.trim()}
                className="px-4 py-2.5 rounded-xl bg-[#1f1f23] hover:bg-[#292a2d] border border-[#48454d]/40 hover:border-[#fbcfe8]/50 text-xs font-mono font-semibold text-[#e3e2e6] flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed shrink-0"
              >
                {isFetchingIssue ? (
                  <>
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-[#fbcfe8] border-t-transparent animate-spin" />
                    <span>Fetching...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[16px] text-[#fbcfe8]">download</span>
                    <span>Fetch Issue</span>
                  </>
                )}
              </button>
            </div>

            {issueFetchError && (
              <div className="mt-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2">
                <span className="material-symbols-outlined text-[16px] text-red-400 shrink-0 mt-0.5">
                  error
                </span>
                <span>{issueFetchError}</span>
              </div>
            )}

            {fetchedIssueMeta && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-[#1c1e26] border border-[#fbcfe8]/30 text-xs font-mono">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="px-2 py-0.5 rounded-md bg-[#fbcfe8]/15 text-[#fbcfe8] font-bold shrink-0">
                    #{fetchedIssueMeta.issueNumber}
                  </span>
                  <span className="text-[#e3e2e6] truncate">{fetchedIssueMeta.issueTitle}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setFetchedIssueMeta(null);
                    setIssueUrlInput('');
                  }}
                  className="text-[#938f98] hover:text-white text-[11px] cursor-pointer"
                >
                  Clear link
                </button>
              </div>
            )}

            {fetchedIssueMeta?.repoMismatchWarning && (
              <div className="mt-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/35 text-amber-200 text-xs font-mono flex items-start gap-2">
                <span className="material-symbols-outlined text-[17px] text-amber-300 shrink-0 mt-0.5">
                  warning
                </span>
                <span>{fetchedIssueMeta.repoMismatchWarning}</span>
              </div>
            )}
          </div>

          {/* Issue text textarea */}
          <div className="space-y-1.5">
            <label className="text-xs font-mono font-medium text-[#cac5ce] uppercase tracking-wider block">
              Issue Title & Description
            </label>
            <textarea
              value={issueText}
              onChange={(e) => setIssueText(e.target.value)}
              placeholder="Paste a GitHub issue title/body or describe the bug or change (e.g. Profile.js: Edit button is non-functional)"
              rows={6}
              disabled={isGeneratingPlan}
              className="w-full bg-[#1c1e26] border border-[#48454d]/40 rounded-2xl p-4 text-xs sm:text-sm text-white placeholder:text-[#6a6770] focus:border-[#fbcfe8]/70 focus:outline-none transition-all shadow-inner font-mono resize-y"
            />
          </div>

          {/* Submit bar */}
          <div className="flex items-center justify-between pt-2 border-t border-[#48454d]/25">
            <span className="text-[11px] font-mono text-[#938f98]">
              Issue text is analyzed with hybrid filename, AST symbol & semantic search.
            </span>

            <button
              type="button"
              onClick={() => handleGeneratePlan()}
              disabled={isGeneratingPlan || !issueText.trim()}
              className="py-2.5 px-5 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-xs font-mono font-bold transition-all shadow-lg flex items-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {isGeneratingPlan ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-[#3d1729] border-t-transparent animate-spin" />
                  <span>Generating Plan...</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                  <span>Generate Plan</span>
                </>
              )}
            </button>
          </div>

          {/* LLM failure alert with Retry button */}
          {planError && (
            <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/35 text-red-200 text-xs font-mono flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-red-400 shrink-0 mt-0.5">
                  error
                </span>
                <span className="leading-relaxed">{planError.message}</span>
              </div>
              {planError.retryable && (
                <button
                  type="button"
                  onClick={() => handleGeneratePlan()}
                  disabled={isGeneratingPlan}
                  className="px-3.5 py-1.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-400/40 text-red-100 font-bold text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
                >
                  <span className="material-symbols-outlined text-[15px]">refresh</span>
                  <span>Retry</span>
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* Plan Generation Progress */}
      {isGeneratingPlan && (
        <section className="bg-[#13151b]/90 border border-[#fbcfe8]/30 rounded-3xl p-8 shadow-2xl flex flex-col items-center justify-center text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-[#241c2c] border border-[#fbcfe8]/50 flex items-center justify-center text-[#fbcfe8] shadow-xl">
            <div className="w-6 h-6 rounded-full border-2 border-[#fbcfe8] border-t-transparent animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-heading font-semibold text-white">
              {LOADING_STAGES[loadingStageIdx]}
            </h3>
            <p className="text-xs font-mono text-[#938f98]">
              Grounding recommendations in indexed repository files and AST symbols
            </p>
          </div>
        </section>
      )}

      {/* STEP 2: CONTRIBUTOR PLAN VIEW */}
      {activeStep === 'plan' && !isGeneratingPlan && currentPlan && normalizedPlan && (
        <div className="space-y-5 animate-in fade-in duration-200">
          {/* Action Toolbar */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-[#161820]/95 border border-[#48454d]/30 rounded-2xl p-4 shadow-xl">
            <div className="space-y-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold uppercase tracking-wider border ${
                    normalizedPlan.issueType === 'bug'
                      ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                      : 'bg-sky-500/15 border-sky-500/30 text-sky-300'
                  }`}
                >
                  {normalizedPlan.issueType}
                </span>
                {currentPlan.issueNumber && currentPlan.issueUrl && (
                  <a
                    href={currentPlan.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] font-mono text-[#fbcfe8] hover:underline flex items-center gap-1"
                  >
                    <span>Issue #{currentPlan.issueNumber}</span>
                    <span className="material-symbols-outlined text-[12px]">open_in_new</span>
                  </a>
                )}
              </div>
              <div className="text-sm font-heading font-semibold text-white line-clamp-2">
                {currentPlan.issueTitle || currentPlan.featureRequest}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={() => onSyncAnalysisUrl?.({ step: 'issue', plan: null, changeset: null })}
                className="py-2 px-3 rounded-xl bg-[#1c1e26] hover:bg-[#262832] border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] cursor-pointer transition-colors"
              >
                New Issue
              </button>

              <button
                type="button"
                disabled
                title="Rethink plan with feedback will be enabled in Phase 2"
                className="py-2 px-3 rounded-xl bg-[#1c1e26] border border-[#48454d]/35 text-xs font-mono text-[#938f98] flex items-center gap-1.5 opacity-60 cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[15px]">psychology_alt</span>
                <span>Rethink plan</span>
              </button>

              <button
                type="button"
                onClick={handleImplementPlan}
                disabled={isGeneratingCode}
                className="py-2 px-4 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-xs font-mono font-bold transition-all shadow-lg flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isGeneratingCode ? (
                  <>
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-[#3d1729] border-t-transparent animate-spin" />
                    <span>Implementing...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[16px]">code</span>
                    <span>Implement plan</span>
                  </>
                )}
              </button>

              {!hasGitHubUpstream && (
                <button
                  type="button"
                  disabled
                  title="Disabled: uploaded ZIP repositories have no GitHub upstream remote"
                  className="py-2 px-3 rounded-xl bg-[#1c1e26] border border-[#48454d]/30 text-[#938f98] text-xs font-mono flex items-center gap-1.5 opacity-60 cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-[15px]">merge_type</span>
                  <span>Create PR</span>
                </button>
              )}
            </div>
          </div>

          {codeGenError && (
            <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-start gap-2">
              <span className="material-symbols-outlined text-[17px] text-red-400 shrink-0">error</span>
              <span>{codeGenError}</span>
            </div>
          )}

          {/* Low retrieval confidence notice */}
          {(normalizedPlan.retrievalConfidence === 'low' || normalizedPlan.confidenceNote) && (
            <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono flex items-start gap-2.5">
              <span className="material-symbols-outlined text-[18px] text-amber-300 shrink-0 mt-0.5">
                warning
              </span>
              <div className="space-y-1">
                {normalizedPlan.retrievalConfidence === 'low' && (
                  <div className="font-bold text-amber-100">
                    Low retrieval confidence — the exact file or symbol mentioned may not have matched strongly.
                  </div>
                )}
                {normalizedPlan.confidenceNote && <div>{normalizedPlan.confidenceNote}</div>}
              </div>
            </div>
          )}

          {/* 1. Understanding */}
          {normalizedPlan.understanding && (
            <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-2xl p-5 shadow-lg space-y-2">
              <div className="flex items-center gap-2 text-[#fbcfe8]">
                <span className="material-symbols-outlined text-[18px]">lightbulb</span>
                <h2 className="text-xs font-mono font-bold uppercase tracking-wider">
                  Understanding
                </h2>
              </div>
              <p className="text-sm text-[#e3e2e6] leading-relaxed">{normalizedPlan.understanding}</p>
            </section>
          )}

          {/* 2. Likely cause (bugs only) */}
          {normalizedPlan.likelyCause && (
            <section className="bg-[#13151b]/95 border border-rose-500/30 rounded-2xl p-5 shadow-lg space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-rose-300">
                  <span className="material-symbols-outlined text-[18px]">bug_report</span>
                  <h2 className="text-xs font-mono font-bold uppercase tracking-wider">
                    Likely cause
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onSelectFile?.(normalizedPlan.likelyCause!.filePath)}
                  className="px-2.5 py-1 rounded-lg bg-[#1c1e26] hover:bg-[#292a2d] border border-rose-500/25 text-[11px] font-mono text-rose-200 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  <span>{normalizedPlan.likelyCause.filePath}</span>
                  <span className="text-[#938f98]">·</span>
                  <span className="text-[#fbcfe8]">{normalizedPlan.likelyCause.symbolOrFunction}</span>
                  {normalizedPlan.likelyCause.lineRange && (
                    <span className="text-[#938f98]">({normalizedPlan.likelyCause.lineRange})</span>
                  )}
                </button>
              </div>
              <p className="text-xs sm:text-sm text-[#e3e2e6] leading-relaxed">
                {normalizedPlan.likelyCause.summary}
              </p>
            </section>
          )}

          {/* 3. Files to change */}
          {normalizedPlan.filesToChange.length > 0 && (
            <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-2xl p-5 shadow-lg space-y-3">
              <div className="flex items-center gap-2 text-[#b7c8e1]">
                <span className="material-symbols-outlined text-[18px]">edit_document</span>
                <h2 className="text-xs font-mono font-bold uppercase tracking-wider">
                  Files to change ({normalizedPlan.filesToChange.length})
                </h2>
              </div>
              <div className="space-y-2.5">
                {normalizedPlan.filesToChange.map((file, idx) => (
                  <div
                    key={idx}
                    onClick={() => {
                      if (file.changeType === 'modify' && onSelectFile) {
                        onSelectFile(file.filePath);
                      }
                    }}
                    className={`p-3.5 rounded-xl bg-[#1c1e26] border border-[#48454d]/30 space-y-1.5 ${
                      file.changeType === 'modify'
                        ? 'hover:border-[#fbcfe8]/50 cursor-pointer'
                        : ''
                    } transition-colors`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono font-bold text-white truncate">
                          {file.filePath}
                        </span>
                        {file.symbolOrLines && (
                          <span className="px-2 py-0.5 rounded bg-[#292a2d] text-[10px] font-mono text-[#b7c8e1]">
                            {file.symbolOrLines}
                          </span>
                        )}
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-md text-[9px] font-mono font-bold uppercase tracking-wider border shrink-0 ${
                          file.changeType === 'create'
                            ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                            : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                        }`}
                      >
                        {file.changeType === 'create' ? 'NEW FILE' : 'MODIFY'}
                      </span>
                    </div>
                    <p className="text-xs text-[#cac5ce] leading-relaxed">{file.reason}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 4. Steps */}
          {normalizedPlan.steps.length > 0 && (
            <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-2xl p-5 shadow-lg space-y-3">
              <div className="flex items-center gap-2 text-[#fbcfe8]">
                <span className="material-symbols-outlined text-[18px]">checklist</span>
                <h2 className="text-xs font-mono font-bold uppercase tracking-wider">Steps</h2>
              </div>
              <ol className="space-y-2.5">
                {normalizedPlan.steps.map((step) => (
                  <li
                    key={step.step}
                    className="p-3.5 rounded-xl bg-[#1c1e26] border border-[#48454d]/30 flex items-start gap-3"
                  >
                    <span className="w-6 h-6 rounded-full bg-[#241c2c] border border-[#fbcfe8]/40 text-[#fbcfe8] text-[11px] font-mono font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {step.step}
                    </span>
                    <div className="space-y-1.5 min-w-0">
                      <p className="text-xs sm:text-sm text-[#e3e2e6] leading-relaxed">
                        {step.action}
                      </p>
                      {(step.targetFile || step.symbols.length > 0) && (
                        <div className="flex flex-wrap gap-1.5">
                          {step.targetFile && (
                            <button
                              type="button"
                              onClick={() => onSelectFile?.(step.targetFile!)}
                              className="px-2 py-0.5 rounded-md bg-[#292a2d] hover:bg-[#343538] text-[10px] font-mono text-[#b7c8e1] hover:text-white cursor-pointer"
                            >
                              {step.targetFile}
                            </button>
                          )}
                          {step.symbols.map((sym, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 rounded-md bg-[#241c2c] text-[10px] font-mono text-[#fbcfe8]"
                            >
                              {sym}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* 5. How to test & 6. Risks (only render if non-empty) */}
          {(normalizedPlan.howToTest.length > 0 || normalizedPlan.risks.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {normalizedPlan.howToTest.length > 0 && (
                <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-2xl p-5 shadow-lg space-y-2.5">
                  <div className="flex items-center gap-2 text-emerald-300">
                    <span className="material-symbols-outlined text-[18px]">science</span>
                    <h2 className="text-xs font-mono font-bold uppercase tracking-wider">
                      How to test
                    </h2>
                  </div>
                  <ul className="space-y-1.5">
                    {normalizedPlan.howToTest.map((item, idx) => (
                      <li key={idx} className="text-xs text-[#cac5ce] leading-relaxed flex gap-2">
                        <span className="text-emerald-400 font-mono shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {normalizedPlan.risks.length > 0 && (
                <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-2xl p-5 shadow-lg space-y-2.5">
                  <div className="flex items-center gap-2 text-amber-300">
                    <span className="material-symbols-outlined text-[18px]">warning</span>
                    <h2 className="text-xs font-mono font-bold uppercase tracking-wider">
                      Risks
                    </h2>
                  </div>
                  <ul className="space-y-1.5">
                    {normalizedPlan.risks.map((item, idx) => (
                      <li key={idx} className="text-xs text-[#cac5ce] leading-relaxed flex gap-2">
                        <span className="text-amber-400 font-mono shrink-0">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}

          {/* Compact Evidence Used */}
          {normalizedPlan.evidenceUsed.length > 0 && (
            <section className="bg-[#13151b]/80 border border-[#48454d]/25 rounded-2xl px-4 py-3 space-y-2">
              <button
                type="button"
                onClick={() => setIsEvidenceExpanded((v) => !v)}
                className="w-full flex items-center justify-between text-xs font-mono text-[#938f98] hover:text-[#e3e2e6] cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">verified</span>
                  <span className="font-semibold uppercase tracking-wider">Evidence used</span>
                  <span className="text-[11px] text-[#cac5ce]">
                    ({normalizedPlan.evidenceUsed.length} files
                    {normalizedPlan.chunkCount ? ` · ${normalizedPlan.chunkCount} snippets` : ''})
                  </span>
                </div>
                <span className="material-symbols-outlined text-[16px]">
                  {isEvidenceExpanded ? 'expand_less' : 'expand_more'}
                </span>
              </button>

              {isEvidenceExpanded ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {normalizedPlan.evidenceUsed.map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onSelectFile?.(item.filePath)}
                      className="px-2.5 py-1 rounded-lg bg-[#1c1e26] hover:bg-[#292a2d] border border-[#48454d]/30 text-[11px] font-mono text-[#cac5ce] hover:text-white flex items-center gap-1.5 cursor-pointer"
                    >
                      <span>{item.filePath}</span>
                      <span className="px-1.5 py-0.2 rounded bg-[#292a2d] text-[9px] uppercase text-[#fbcfe8]">
                        {item.matchSource}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {normalizedPlan.evidenceUsed.slice(0, 5).map((item, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onSelectFile?.(item.filePath)}
                      className="px-2 py-0.5 rounded-md bg-[#1c1e26] hover:bg-[#292a2d] border border-[#48454d]/25 text-[10px] font-mono text-[#b7c8e1] hover:text-white cursor-pointer"
                    >
                      {item.filePath}
                    </button>
                  ))}
                  {normalizedPlan.evidenceUsed.length > 5 && (
                    <span className="text-[10px] font-mono text-[#938f98] self-center">
                      +{normalizedPlan.evidenceUsed.length - 5} more
                    </span>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* Code Gen Loading */}
      {isGeneratingCode && (
        <section className="bg-[#13151b]/90 border border-[#fbcfe8]/30 rounded-3xl p-8 shadow-2xl flex flex-col items-center justify-center text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-[#241c2c] border border-[#fbcfe8]/50 flex items-center justify-center text-[#fbcfe8] shadow-xl">
            <div className="w-6 h-6 rounded-full border-2 border-[#fbcfe8] border-t-transparent animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-heading font-semibold text-white">
              {CODE_GEN_STAGES[codeGenStageIdx]}
            </h3>
            <p className="text-xs font-mono text-[#938f98]">
              Generating repository-grounded file changes
            </p>
          </div>
        </section>
      )}

      {/* STEP 3: CODE CHANGES */}
      {activeStep === 'changes' && !isGeneratingCode && currentPlan && currentChangeset && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#161820]/95 border border-[#48454d]/30 rounded-2xl px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-mono text-[#cac5ce]">
              <button
                type="button"
                onClick={() =>
                  onSyncAnalysisUrl?.({
                    step: 'plan',
                    plan: currentPlan.id,
                    changeset: currentChangeset.id,
                  })
                }
                className="text-[#b7c8e1] hover:text-white flex items-center gap-1 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px]">arrow_back</span>
                <span>Back to Plan</span>
              </button>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled
                title="Rethink changes with feedback will be enabled in Phase 2"
                className="py-1.5 px-3 rounded-xl bg-[#1c1e26] border border-[#48454d]/35 text-xs font-mono text-[#938f98] flex items-center gap-1.5 opacity-60 cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[15px]">psychology_alt</span>
                <span>Rethink changes</span>
              </button>

              <button
                type="button"
                disabled={!hasGitHubUpstream}
                title={
                  !hasGitHubUpstream
                    ? 'Create PR is disabled because this repo was uploaded as a ZIP archive'
                    : 'Proceed to Pull Request'
                }
                onClick={() => {
                  if (!hasGitHubUpstream) return;
                  onSyncAnalysisUrl?.({
                    step: 'pr',
                    plan: currentPlan.id,
                    changeset: currentChangeset.id,
                  });
                }}
                className="py-1.5 px-4 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-xs font-mono font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined text-[15px]">merge_type</span>
                <span>Create PR</span>
              </button>
            </div>
          </div>

          <DiffViewer
            changeset={currentChangeset}
            allChangesets={allChangesets}
            onSelectChangeset={(id) => {
              onSyncAnalysisUrl?.({
                step: 'changes',
                plan: currentPlan.id,
                changeset: id,
              });
            }}
            onApprove={handleApproveChangeset}
            onReject={handleRejectChangeset}
            onRegenerate={handleImplementPlan}
            isGenerating={isGeneratingCode}
            hasGitHubUpstream={hasGitHubUpstream}
            onOpenPrStep={() => {
              if (!hasGitHubUpstream) return;
              onSyncAnalysisUrl?.({
                step: 'pr',
                plan: currentPlan.id,
                changeset: currentChangeset.id,
              });
            }}
          />
        </div>
      )}

      {/* STEP 4: PULL REQUEST */}
      {activeStep === 'pr' && currentPlan && currentChangeset && (
        <section className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-3xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[#fbcfe8]">
              <span className="material-symbols-outlined text-[20px]">merge_type</span>
              <h2 className="text-sm font-mono font-bold uppercase tracking-wider">
                Create Pull Request
              </h2>
            </div>
            <button
              type="button"
              onClick={() =>
                onSyncAnalysisUrl?.({
                  step: 'changes',
                  plan: currentPlan.id,
                  changeset: currentChangeset.id,
                })
              }
              className="px-3 py-1.5 rounded-xl bg-[#1c1e26] hover:bg-[#262832] border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] cursor-pointer"
            >
              Back to Code changes
            </button>
          </div>

          {!hasGitHubUpstream ? (
            <div className="p-4 rounded-2xl bg-[#1c1e26] border border-[#48454d]/30 text-xs font-mono text-[#938f98]">
              Create PR is disabled for ZIP-uploaded repositories without a GitHub upstream remote.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-[#1c1e26] border border-[#48454d]/30 text-xs font-mono text-[#cac5ce] space-y-2">
                <p>
                  Contributor fork-first PR creation (auto-forking when you lack push access, creating <span className="text-[#fbcfe8]">codegraph/{currentPlan.issueNumber || 'issue'}-...</span>, syncing upstream, and prefilling <span className="text-white">Fixes #{currentPlan.issueNumber || 'N'}</span>) arrives in Phase 2.
                </p>
                <p className="text-[#938f98]">
                  In the meantime, if you have write access to <strong className="text-white">{repo.fullName}</strong>, you can approve and stage a branch directly from <strong className="text-white">Code changes</strong>.
                </p>
              </div>
              <DiffViewer
                changeset={currentChangeset}
                allChangesets={allChangesets}
                onSelectChangeset={(id) => {
                  onSyncAnalysisUrl?.({
                    step: 'pr',
                    plan: currentPlan.id,
                    changeset: id,
                  });
                }}
                onApprove={handleApproveChangeset}
                onReject={handleRejectChangeset}
                onRegenerate={handleImplementPlan}
                isGenerating={isGeneratingCode}
                hasGitHubUpstream={hasGitHubUpstream}
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
};
