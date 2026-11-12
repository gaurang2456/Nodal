'use client';
import React, { useState, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  GeneratedChangeset,
  GeneratedFileChange,
  ValidationResult,
  ValidationStatus,
  GitHubConnectionStatus,
  ChangesetBranch,
  PullRequestRecord,
} from '@/types';
import { computeLineDiff, calculateDiffStats, DiffLine } from '@/server/planner/diffUtils';
import { createClient } from '@/lib/supabase/client';
import {
  useGitHubConnection,
  useChangesetBranch,
  useChangesetPR,
  useChangesetValidation,
  invalidateChangesetBranch,
  invalidateChangesetPR,
  invalidateValidation,
  GITHUB_KEYS,
  VALIDATION_KEYS,
} from '@/lib/api/queries';

export interface DiffViewerProps {
  changeset: GeneratedChangeset;
  allChangesets?: GeneratedChangeset[];
  onSelectChangeset?: (changesetId: string) => void;
  onApprove?: (changesetId: string) => Promise<void>;
  onReject?: (changesetId: string) => Promise<void>;
  onRegenerate?: () => Promise<void>;
  isGenerating?: boolean;
  hasGitHubUpstream?: boolean;
  onOpenPrStep?: () => void;
}

const VALIDATION_PROGRESS_STAGES = [
  'Preparing validation workspace...',
  'Reconstructing repository from database...',
  'Applying generated code changes...',
  'Running TypeScript type checks...',
  'Building production artifacts...',
  'Executing automated tests...',
  'Cleaning up temporary workspace...',
];

export const DiffViewer: React.FC<DiffViewerProps> = ({
  changeset,
  allChangesets = [],
  onSelectChangeset,
  onApprove,
  onReject,
  onRegenerate,
  isGenerating = false,
  hasGitHubUpstream = true,
  onOpenPrStep,
}) => {
  const [selectedFileIdx, setSelectedFileIdx] = useState(0);
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>('unified');
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const queryClient = useQueryClient();

  // Shared GitHub connection status
  const { data: githubData } = useGitHubConnection();
  const githubConnection = githubData || null;

  // Cached branch for this changeset
  const { data: branchData } = useChangesetBranch(changeset.id);
  const changesetBranch = branchData?.branch || null;

  // Cached PR for this changeset
  const { data: prData } = useChangesetPR(changeset.id);
  const pullRequest = prData?.pullRequest || null;

  // Cached validation result for this changeset
  const { data: valData } = useChangesetValidation(changeset.id);
  const validationResult = valData?.validation || null;

  const [isConnectingGitHub, setIsConnectingGitHub] = useState(false);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);

  const supabase = createClient();

  const handleCreatePullRequest = async () => {
    setIsCreatingPr(true);
    setPrError(null);
    try {
      const res = await fetch(`/api/changesets/${changeset.id}/github/pr`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.pullRequest) {
        queryClient.setQueryData(GITHUB_KEYS.pr(changeset.id), { pullRequest: data.pullRequest });
        invalidateChangesetPR(queryClient, changeset.id);
      } else {
        setPrError(data.error || 'Failed to create Pull Request.');
      }
    } catch (err: any) {
      setPrError(err.message || 'Network error while creating Pull Request.');
    } finally {
      setIsCreatingPr(false);
    }
  };

  const handleCreateBranch = async () => {
    setIsCreatingBranch(true);
    setBranchError(null);
    try {
      const res = await fetch(`/api/changesets/${changeset.id}/github/branch`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.branch) {
        queryClient.setQueryData(GITHUB_KEYS.branch(changeset.id), { branch: data.branch });
        invalidateChangesetBranch(queryClient, changeset.id);
      } else {
        setBranchError(data.error || 'Failed to create GitHub branch.');
      }
    } catch (err: any) {
      setBranchError(err.message || 'Network error while creating branch.');
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handleCommitAndPush = async () => {
    setIsCommitting(true);
    setCommitError(null);
    try {
      const res = await fetch(`/api/changesets/${changeset.id}/github/commit`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.branch) {
        queryClient.setQueryData(GITHUB_KEYS.branch(changeset.id), { branch: data.branch });
        invalidateChangesetBranch(queryClient, changeset.id);
      } else {
        setCommitError(data.error || 'Failed to commit and push changes.');
      }
    } catch (err: any) {
      setCommitError(err.message || 'Network error while committing to branch.');
    } finally {
      setIsCommitting(false);
    }
  };

  const handleConnectGitHub = async () => {
    setIsConnectingGitHub(true);
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${origin}/auth/github/callback`,
          scopes: 'repo',
        },
      });
    } catch {
      setIsConnectingGitHub(false);
    }
  };

  // Validation State
  const [isValidating, setIsValidating] = useState(false);
  const [valProgressIdx, setValProgressIdx] = useState(0);
  const [expandedLogChecks, setExpandedLogChecks] = useState<Record<string, boolean>>({});

  const currentFile: GeneratedFileChange | undefined =
    changeset.changes[selectedFileIdx] || changeset.changes[0];

  // Validation progress animation
  useEffect(() => {
    if (!isValidating) return;
    const interval = setInterval(() => {
      setValProgressIdx((prev) => (prev + 1) % VALIDATION_PROGRESS_STAGES.length);
    }, 2400);
    return () => clearInterval(interval);
  }, [isValidating]);

  const handleRunValidation = async () => {
    setIsValidating(true);
    setValProgressIdx(0);
    try {
      const res = await fetch(`/api/changesets/${changeset.id}/validate`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.validation) {
          queryClient.setQueryData(VALIDATION_KEYS.detail(changeset.id), { validation: data.validation });
        }
        invalidateValidation(queryClient, changeset.id);
      }
    } catch (err) {
      console.error('Validation error:', err);
    } finally {
      setIsValidating(false);
    }
  };

  const toggleCheckLogs = (checkName: string) => {
    setExpandedLogChecks((prev) => ({
      ...prev,
      [checkName]: !prev[checkName],
    }));
  };

  // Calculate line diffs for selected file
  const diffLines: DiffLine[] = useMemo(() => {
    if (!currentFile) return [];
    const orig = currentFile.originalContent || '';
    const prop = currentFile.proposedContent || '';
    return computeLineDiff(orig, prop);
  }, [currentFile]);

  // Calculate file stats
  const fileStatsMap = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    for (const fc of changeset.changes) {
      map.set(fc.filePath, calculateDiffStats(fc.originalContent || '', fc.proposedContent || ''));
    }
    return map;
  }, [changeset.changes]);

  // Total changeset stats
  const totalStats = useMemo(() => {
    let adds = 0;
    let dels = 0;
    fileStatsMap.forEach((val) => {
      adds += val.additions;
      dels += val.deletions;
    });
    return { additions: adds, deletions: dels };
  }, [fileStatsMap]);

  const handleCopyCode = () => {
    if (!currentFile) return;
    navigator.clipboard.writeText(currentFile.proposedContent);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleStatusUpdate = async (status: 'approved' | 'rejected') => {
    if (isUpdatingStatus) return;
    setIsUpdatingStatus(true);
    try {
      if (status === 'approved' && onApprove) {
        await onApprove(changeset.id);
      } else if (status === 'rejected' && onReject) {
        await onReject(changeset.id);
      }
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const isReadyForPR = changeset.status === 'approved' && validationResult?.status === 'passed';

  const statusBadge = () => {
    switch (changeset.status) {
      case 'approved':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-mono font-bold">
            <span className="material-symbols-outlined text-[15px]">check_circle</span>
            <span>Approved</span>
          </span>
        );
      case 'rejected':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs font-mono font-bold">
            <span className="material-symbols-outlined text-[15px]">cancel</span>
            <span>Rejected</span>
          </span>
        );
      case 'generating':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs font-mono font-bold animate-pulse">
            <div className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
            <span>Generating...</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 text-xs font-mono font-bold">
            <span className="material-symbols-outlined text-[15px]">rate_review</span>
            <span>Ready for Review</span>
          </span>
        );
    }
  };

  return (
    <div className="bg-[#13151b]/95 border border-[#48454d]/35 rounded-3xl p-6 shadow-2xl space-y-6 animate-in fade-in duration-300">
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-[#48454d]/25">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-[#70485c]/30 border border-[#fbcfe8]/40 flex items-center justify-center text-[#fbcfe8]">
              <span className="material-symbols-outlined text-[18px]">difference</span>
            </div>
            <div>
              <h2 className="text-base font-heading font-bold text-white flex items-center gap-2">
                <span>Proposed Code Changes</span>
                <span className="text-xs font-mono text-[#938f98] font-normal">
                  (v{changeset.version})
                </span>
              </h2>
            </div>
            {statusBadge()}
          </div>
          <p className="text-xs text-[#cac5ce] font-sans pl-11">{changeset.summary}</p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Version Switcher */}
          {allChangesets.length > 1 && onSelectChangeset && (
            <select
              value={changeset.id}
              onChange={(e) => onSelectChangeset(e.target.value)}
              className="bg-[#1c1e26] border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] rounded-xl px-3 py-1.5 focus:outline-none focus:border-[#fbcfe8]/60 cursor-pointer"
            >
              {allChangesets.map((cs) => (
                <option key={cs.id} value={cs.id}>
                  v{cs.version} ({cs.status}) - {new Date(cs.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </option>
              ))}
            </select>
          )}

          {/* Run Validation Button */}
          <button
            onClick={handleRunValidation}
            disabled={isValidating || isGenerating}
            className="py-1.5 px-3.5 rounded-xl bg-gradient-to-r from-blue-600/90 to-indigo-600/90 hover:from-blue-500 hover:to-indigo-500 border border-blue-400/40 text-white text-xs font-mono font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            title="Execute typecheck, build, and tests in an isolated workspace"
          >
            {isValidating ? (
              <>
                <div className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span>Validating...</span>
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-[15px]">verified</span>
                <span>Run Validation</span>
              </>
            )}
          </button>

          {/* Regenerate Button */}
          {onRegenerate && (
            <button
              onClick={onRegenerate}
              disabled={isGenerating || isUpdatingStatus || isValidating}
              className="py-1.5 px-3 rounded-xl bg-[#1c1e26] hover:bg-[#292a2d] border border-[#48454d]/40 text-xs font-mono text-[#cac5ce] hover:text-white transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
              title="Generate a new changeset version without overwriting existing versions"
            >
              <span className="material-symbols-outlined text-[15px]">sync</span>
              <span>Regenerate</span>
            </button>
          )}

          {/* Review Actions */}
          {changeset.status !== 'approved' && onApprove && (
            <button
              onClick={() => handleStatusUpdate('approved')}
              disabled={isUpdatingStatus || isGenerating || isValidating}
              className="py-1.5 px-3.5 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 border border-emerald-400/40 text-white text-xs font-mono font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[16px]">check</span>
              <span>Approve Changes</span>
            </button>
          )}

          {changeset.status !== 'rejected' && onReject && (
            <button
              onClick={() => handleStatusUpdate('rejected')}
              disabled={isUpdatingStatus || isGenerating || isValidating}
              className="py-1.5 px-3 rounded-xl bg-[#1c1e26] hover:bg-rose-500/20 border border-[#48454d]/40 hover:border-rose-500/40 text-[#cac5ce] hover:text-rose-200 text-xs font-mono transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[15px]">close</span>
              <span>Reject</span>
            </button>
          )}
        </div>
      </div>

      {/* Validation Progress Card */}
      {isValidating && (
        <div className="p-5 rounded-2xl bg-blue-950/40 border border-blue-500/40 space-y-3 animate-in fade-in">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            <div className="space-y-0.5">
              <div className="text-xs font-mono font-bold text-blue-200">
                {VALIDATION_PROGRESS_STAGES[valProgressIdx]}
              </div>
              <div className="text-[11px] font-mono text-[#938f98]">
                Reconstructing repository in isolated workspace and executing tests
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Validation Result Report Card */}
      {!isValidating && validationResult && (
        <div className="p-5 rounded-2xl bg-[#161820] border border-[#48454d]/35 space-y-4 animate-in fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-blue-400">
                science
              </span>
              <h3 className="text-xs font-mono font-bold text-white uppercase tracking-wider">
                Code Validation Report
              </h3>
            </div>

            {validationResult.status === 'passed' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[11px] font-mono font-bold">
                <span className="material-symbols-outlined text-[14px]">check</span>
                <span>VALIDATION PASSED</span>
              </span>
            )}
            {validationResult.status === 'failed' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[11px] font-mono font-bold">
                <span className="material-symbols-outlined text-[14px]">close</span>
                <span>VALIDATION FAILED</span>
              </span>
            )}
            {validationResult.status === 'skipped' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[11px] font-mono font-bold">
                <span className="material-symbols-outlined text-[14px]">do_not_disturb_on</span>
                <span>VALIDATION SKIPPED</span>
              </span>
            )}
            {validationResult.status === 'error' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[11px] font-mono font-bold">
                <span className="material-symbols-outlined text-[14px]">warning</span>
                <span>VALIDATION ERROR</span>
              </span>
            )}
          </div>

          <p className="text-xs text-[#cac5ce] font-sans leading-relaxed">
            {validationResult.summary}
          </p>

          {/* Validation Checks Table */}
          <div className="divide-y divide-[#48454d]/20 border border-[#48454d]/25 rounded-xl overflow-hidden bg-[#121316]">
            {validationResult.checks.map((check, cIdx) => {
              const isExpanded = expandedLogChecks[check.name] || false;
              const hasErrors = check.errors && check.errors.length > 0;

              return (
                <div key={cIdx} className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      {check.status === 'passed' && (
                        <span className="material-symbols-outlined text-[16px] text-emerald-400">
                          check_circle
                        </span>
                      )}
                      {check.status === 'failed' && (
                        <span className="material-symbols-outlined text-[16px] text-rose-400">
                          cancel
                        </span>
                      )}
                      {check.status === 'skipped' && (
                        <span className="material-symbols-outlined text-[16px] text-amber-400">
                          do_not_disturb_on
                        </span>
                      )}
                      {check.status === 'error' && (
                        <span className="material-symbols-outlined text-[16px] text-rose-400">
                          error
                        </span>
                      )}
                      <span className="text-xs font-mono font-bold text-[#e3e2e6]">
                        {check.name}
                      </span>
                      {check.command && (
                        <span className="text-[10px] font-mono text-[#6a6770]">
                          ({check.command})
                        </span>
                      )}
                      {check.status === 'skipped' && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          Skipped
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      {check.durationMs !== undefined && check.durationMs > 0 && (
                        <span className="text-[10px] font-mono text-[#938f98]">
                          {(check.durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                      {check.output && (
                        <button
                          onClick={() => toggleCheckLogs(check.name)}
                          className="text-[10px] font-mono text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
                        >
                          {isExpanded ? 'Hide Logs' : 'View Logs'}
                        </button>
                      )}
                    </div>
                  </div>

                  {check.message && (
                    <div className="text-[11px] font-mono text-[#cac5ce] pl-6">
                      {check.message}
                    </div>
                  )}

                  {/* Formatted Errors */}
                  {hasErrors && (
                    <div className="space-y-1.5 pl-6">
                      {check.errors?.map((err, eIdx) => (
                        <div
                          key={eIdx}
                          className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/25 text-[11px] font-mono text-rose-200"
                        >
                          {err.filePath && (
                            <span className="font-bold text-rose-300 mr-1.5">
                              {err.filePath}
                              {err.line ? `:${err.line}` : ''}
                            </span>
                          )}
                          <span>{err.message}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Expandable Full Console Output */}
                  {isExpanded && check.output && (
                    <div className="mt-2 p-3 rounded-xl bg-[#090a0d] border border-[#48454d]/30 text-[10px] font-mono text-[#b7c8e1] overflow-x-auto max-h-48 whitespace-pre custom-scrollbar">
                      {check.output
                        .replace(/[\u001b\x1b]\[[0-9;?]*[ -/]*[@-~]/g, '')
                        .replace(/[\u001b\x1b]\].*?(?:\u0007|[\u001b\x1b]\\)/g, '')
                        .replace(/(?:\[(?:\d{1,3}(?:;\d{1,3})*)?m)+/g, '')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* PR Readiness Banner */}
      {isReadyForPR ? (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-950/80 to-teal-950/80 border border-emerald-400/40 text-emerald-200 text-xs font-mono flex items-center justify-between shadow-lg animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[22px] text-emerald-400">
              verified
            </span>
            <div>
              <strong className="text-white text-sm">Ready for GitHub Pull Request</strong>
              <div className="text-[11px] text-emerald-300/80">
                Changeset approved and verified against type checking, builds, and tests.
              </div>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-[10px] font-bold text-emerald-300 uppercase tracking-wider border border-emerald-400/30">
            PR Ready
          </span>
        </div>
      ) : changeset.status === 'approved' && validationResult?.status === 'skipped' ? (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-amber-400">
              info
            </span>
            <span>
              <strong>Changes Approved</strong> (Automated validation was skipped because TypeScript or test dependencies are not installed in this repository).
            </span>
          </div>
          <span className="px-2.5 py-1 rounded-lg bg-amber-500/20 text-[10px] font-bold text-amber-300 uppercase tracking-wider border border-amber-400/30">
            Validation Skipped
          </span>
        </div>
      ) : changeset.status === 'approved' && validationResult?.status === 'failed' ? (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs font-mono flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-rose-400">
              cancel
            </span>
            <span>
              <strong>Validation Failed</strong> — Compiler or test errors must be resolved before creating a Pull Request.
            </span>
          </div>
          <button
            onClick={handleRunValidation}
            className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-[10px] font-bold text-rose-300 uppercase tracking-wider transition-colors cursor-pointer"
          >
            Re-run Validation
          </button>
        </div>
      ) : changeset.status === 'approved' && !validationResult ? (
        <div className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs font-mono flex items-center justify-between animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-amber-400">
              warning
            </span>
            <span>
              <strong>Changes Approved</strong>, but validation has not been run yet.
            </span>
          </div>
          <button
            onClick={handleRunValidation}
            className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-[10px] font-bold text-amber-300 uppercase tracking-wider transition-colors cursor-pointer"
          >
            Run Validation
          </button>
        </div>
      ) : null}

      {/* GitHub Status & PR Readiness Indicator */}
      <div className="p-3.5 rounded-2xl bg-[#13151b] border border-[#48454d]/30 text-xs font-mono flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-md animate-in fade-in">
        <div className="flex items-center gap-3">
          <div
            className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 ${
              !hasGitHubUpstream
                ? 'bg-[#292a2d] text-[#938f98] border border-[#48454d]/30'
                : githubConnection?.connected
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}
          >
            <span className="material-symbols-outlined text-[17px]">
              {!hasGitHubUpstream ? 'folder_zip' : githubConnection?.connected ? 'check_circle' : 'warning'}
            </span>
          </div>
          <div>
            <div className="font-bold text-white flex items-center gap-2">
              <span>GitHub Status:</span>
              {!hasGitHubUpstream ? (
                <span className="text-[#938f98]">ZIP upload (no GitHub upstream)</span>
              ) : githubConnection?.connected ? (
                <span className="text-emerald-300">
                  Connected as @{githubConnection.githubLogin}
                </span>
              ) : (
                <span className="text-amber-300">Account not connected</span>
              )}
            </div>
            <div className="text-[11px] text-[#938f98]">
              {!hasGitHubUpstream
                ? 'Pull requests are disabled because this repository was uploaded as a ZIP archive without a GitHub upstream remote.'
                : githubConnection?.connected
                ? 'Ready for Pull Request workflow'
                : 'Connect GitHub to create a Pull Request'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!hasGitHubUpstream ? (
            <button
              type="button"
              disabled
              title="Uploaded ZIP repositories have no GitHub upstream remote"
              className="px-3.5 py-1.5 rounded-xl bg-[#1c1e26] border border-[#48454d]/30 text-[#938f98] text-[11px] font-mono flex items-center gap-1.5 cursor-not-allowed opacity-65"
            >
              <span className="material-symbols-outlined text-[15px]">merge_type</span>
              <span>Create PR</span>
            </button>
          ) : githubConnection?.connected ? (
            changesetBranch ? (
              <a
                href={changesetBranch.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-[11px] font-mono font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                title="View branch on GitHub"
              >
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                <span>View on GitHub</span>
              </a>
            ) : changeset.status === 'approved' ? (
              <button
                onClick={handleCreateBranch}
                disabled={isCreatingBranch}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-[11px] font-mono font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
                title="Create dedicated feature branch and stage changeset"
              >
                <span className="material-symbols-outlined text-[15px]">fork_right</span>
                <span>{isCreatingBranch ? 'Creating Branch...' : 'Create GitHub Branch'}</span>
              </button>
            ) : onOpenPrStep ? (
              <button
                type="button"
                onClick={onOpenPrStep}
                className="px-3.5 py-1.5 rounded-xl bg-[#70485c]/40 hover:bg-[#70485c]/60 border border-[#fbcfe8]/40 text-[#fbcfe8] text-[11px] font-mono font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
              >
                <span className="material-symbols-outlined text-[15px]">merge_type</span>
                <span>Create PR</span>
              </button>
            ) : (
              <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold uppercase tracking-wider">
                Connected
              </span>
            )
          ) : (
            <button
              onClick={handleConnectGitHub}
              disabled={isConnectingGitHub}
              className="px-3 py-1.5 rounded-xl bg-[#292a2d] hover:bg-[#38393e] border border-[#fbcfe8]/30 text-white text-[11px] font-mono font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[14px]">link</span>
              <span>{isConnectingGitHub ? 'Connecting...' : 'Connect GitHub'}</span>
            </button>
          )}
        </div>
      </div>

      {/* GitHub Branch Created / Committed Info Card */}
      {changesetBranch && (
        <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#0d2218]/90 to-[#122820]/90 border border-emerald-500/35 text-emerald-200 text-xs font-mono flex items-center justify-between shadow-lg animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[20px] text-emerald-400">
              {changesetBranch.commitSha ? 'check_circle' : 'fork_right'}
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-white font-bold">{changesetBranch.branchName}</span>
                {changesetBranch.commitSha ? (
                  <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 text-[9px] font-bold uppercase tracking-wider border border-emerald-400/30 text-emerald-300">
                    Committed ({changesetBranch.commitSha.slice(0, 7)})
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-md bg-amber-500/20 text-[9px] font-bold uppercase tracking-wider border border-amber-400/30 text-amber-300">
                    Staged on GitHub
                  </span>
                )}
              </div>
              <div className="text-[11px] text-emerald-300/80">
                {changesetBranch.commitSha ? (
                  <span>
                    Commit pushed to <span className="font-semibold text-white">{changesetBranch.branchName}</span> • Ready for Phase 4.3 Pull Request
                  </span>
                ) : (
                  <span>
                    Created from <span className="font-semibold text-white">{changesetBranch.baseBranch}</span> ({changesetBranch.baseSha.slice(0, 7)}) • {changesetBranch.fileCount} files staged
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!changesetBranch.commitSha ? (
              <button
                onClick={handleCommitAndPush}
                disabled={isCommitting}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-[11px] font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 shadow-md"
                title="Create Git commit and push directly to this feature branch"
              >
                <span className="material-symbols-outlined text-[15px]">publish</span>
                <span>{isCommitting ? 'Committing & Pushing...' : 'Commit & Push to Branch'}</span>
              </button>
            ) : !pullRequest ? (
              <button
                onClick={handleCreatePullRequest}
                disabled={isCreatingPr}
                className="px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 shadow-md"
                title="Create Pull Request targeting repository default branch"
              >
                <span className="material-symbols-outlined text-[15px]">merge_type</span>
                <span>{isCreatingPr ? 'Creating PR...' : 'Create Pull Request'}</span>
              </button>
            ) : null}

            {changesetBranch.commitUrl && (
              <a
                href={changesetBranch.commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2.5 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1 cursor-pointer"
                title="View commit details on GitHub"
              >
                <span>Commit</span>
                <span className="material-symbols-outlined text-[12px]">north_east</span>
              </a>
            )}

            <a
              href={changesetBranch.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1.5 rounded-lg bg-[#292a2d] hover:bg-[#38393e] border border-[#48454d]/30 text-emerald-200 text-[10px] font-bold uppercase tracking-wider transition-colors flex items-center gap-1 cursor-pointer"
              title="View branch on GitHub"
            >
              <span>Branch</span>
              <span className="material-symbols-outlined text-[12px]">north_east</span>
            </a>
          </div>
        </div>
      )}

      {/* GitHub Pull Request Card */}
      {pullRequest && (
        <div className="p-3.5 rounded-2xl bg-gradient-to-r from-[#1b1028]/95 to-[#241335]/95 border border-purple-500/40 text-purple-200 text-xs font-mono flex items-center justify-between shadow-xl animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-[22px] text-purple-400">
              merge_type
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-white font-bold">{pullRequest.title}</span>
                <span className="px-2 py-0.5 rounded-md bg-purple-500/25 text-[9px] font-bold uppercase tracking-wider border border-purple-400/40 text-purple-300">
                  PR #{pullRequest.githubPrNumber} ({pullRequest.status})
                </span>
              </div>
              <div className="text-[11px] text-purple-300/80">
                Merging <span className="font-semibold text-white">{pullRequest.branchName}</span> into <span className="font-semibold text-white">{pullRequest.baseBranch}</span> • Commit: {pullRequest.commitSha.slice(0, 7)}
              </div>
            </div>
          </div>

          <a
            href={pullRequest.githubPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3.5 py-1.5 rounded-xl bg-purple-500 hover:bg-purple-400 text-black text-[11px] font-mono font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-md"
          >
            <span>View Pull Request</span>
            <span className="material-symbols-outlined text-[13px]">north_east</span>
          </a>
        </div>
      )}

      {/* PR Error Banner */}
      {prError && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 text-rose-200 text-xs font-mono flex items-center justify-between shadow-md animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-rose-400 shrink-0">
              warning
            </span>
            <span>{prError}</span>
          </div>
          <button
            onClick={() => setPrError(null)}
            className="text-rose-300/70 hover:text-rose-200 transition-colors p-1 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>
      )}

      {/* Commit Error Banner */}
      {commitError && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 text-rose-200 text-xs font-mono flex items-center justify-between shadow-md animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-rose-400 shrink-0">
              warning
            </span>
            <span>{commitError}</span>
          </div>
          <button
            onClick={() => setCommitError(null)}
            className="text-rose-300/70 hover:text-rose-200 transition-colors p-1 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>
      )}

      {/* Branch Creation / Drift Error Banner */}
      {branchError && (
        <div className="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/35 text-rose-200 text-xs font-mono flex items-center justify-between shadow-md animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px] text-rose-400 shrink-0">
              warning
            </span>
            <span>{branchError}</span>
          </div>
          <button
            onClick={() => setBranchError(null)}
            className="text-rose-300/70 hover:text-rose-200 transition-colors p-1 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>
      )}

      {/* Changeset Overview Stats */}
      <div className="flex items-center justify-between text-xs font-mono text-[#938f98] px-1">
        <div className="flex items-center gap-3">
          <span>
            <strong className="text-white">{changeset.changes.length}</strong> files changed
          </span>
          <span>•</span>
          <span className="text-emerald-400 font-bold">+{totalStats.additions}</span>
          <span className="text-rose-400 font-bold">-{totalStats.deletions}</span>
        </div>

        {/* View Mode Toggle */}
        <div className="inline-flex rounded-xl bg-[#1c1e26] p-0.5 border border-[#48454d]/30">
          <button
            onClick={() => setDiffViewMode('unified')}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
              diffViewMode === 'unified'
                ? 'bg-[#292a2d] text-white shadow-sm font-bold'
                : 'text-[#938f98] hover:text-white'
            }`}
          >
            Unified
          </button>
          <button
            onClick={() => setDiffViewMode('split')}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
              diffViewMode === 'split'
                ? 'bg-[#292a2d] text-white shadow-sm font-bold'
                : 'text-[#938f98] hover:text-white'
            }`}
          >
            Side-by-Side
          </button>
        </div>
      </div>

      {/* File Switcher Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
        {changeset.changes.map((fc, idx) => {
          const stats = fileStatsMap.get(fc.filePath) || { additions: 0, deletions: 0 };
          const isSelected = idx === selectedFileIdx;

          let badgeColor = 'bg-amber-500/15 text-amber-300 border-amber-500/30';
          let badgeText = 'MODIFY';
          if (fc.changeType === 'create') {
            badgeColor = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
            badgeText = 'NEW';
          } else if (fc.changeType === 'delete') {
            badgeColor = 'bg-rose-500/15 text-rose-300 border-rose-500/30';
            badgeText = 'DELETE';
          }

          return (
            <button
              key={fc.id || idx}
              onClick={() => setSelectedFileIdx(idx)}
              className={`px-3 py-2 rounded-xl text-xs font-mono transition-all flex items-center gap-2 shrink-0 cursor-pointer border ${
                isSelected
                  ? 'bg-[#292a2d] border-[#fbcfe8]/50 text-white shadow-md'
                  : 'bg-[#1c1e26] border-[#48454d]/25 text-[#cac5ce] hover:border-[#48454d]/60 hover:text-white'
              }`}
            >
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${badgeColor}`}>
                {badgeText}
              </span>
              <span className="truncate max-w-[200px]">{fc.filePath.split('/').pop()}</span>
              <div className="flex items-center gap-1 text-[10px]">
                {stats.additions > 0 && <span className="text-emerald-400">+{stats.additions}</span>}
                {stats.deletions > 0 && <span className="text-rose-400">-{stats.deletions}</span>}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected File Details Bar */}
      {currentFile && (
        <div className="p-4 rounded-2xl bg-[#1c1e26] border border-[#48454d]/30 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 truncate">
              <span className="material-symbols-outlined text-[16px] text-[#b7c8e1]">
                description
              </span>
              <span className="text-xs font-mono font-bold text-white truncate">
                {currentFile.filePath}
              </span>
            </div>
            <button
              onClick={handleCopyCode}
              className="py-1 px-2.5 rounded-lg bg-[#292a2d] hover:bg-[#343538] text-[11px] font-mono text-[#cac5ce] hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[13px]">
                {copiedCode ? 'check' : 'content_copy'}
              </span>
              <span>{copiedCode ? 'Copied' : 'Copy Proposed'}</span>
            </button>
          </div>

          <p className="text-xs text-[#cac5ce] font-sans leading-relaxed">{currentFile.reason}</p>

          {currentFile.affectedSymbols && currentFile.affectedSymbols.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="text-[10px] font-mono text-[#938f98] uppercase">Affected Symbols:</span>
              {currentFile.affectedSymbols.map((sym, sIdx) => (
                <span
                  key={sIdx}
                  className="px-2 py-0.5 rounded-md bg-[#241c2c] text-[10px] font-mono text-[#fbcfe8] border border-[#fbcfe8]/20"
                >
                  ⚡ {sym}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Code Diff Display Viewport */}
      {currentFile && (
        <div className="rounded-2xl bg-[#0e1015] border border-[#48454d]/35 overflow-hidden shadow-inner font-mono text-xs">
          {/* Unified Diff View */}
          {diffViewMode === 'unified' && (
            <div className="overflow-x-auto max-h-[500px] divide-y divide-[#48454d]/15 custom-scrollbar">
              {diffLines.map((line, lIdx) => {
                let rowBg = 'bg-transparent text-[#e3e2e6]';
                let indicator = ' ';
                if (line.type === 'added') {
                  rowBg = 'bg-emerald-500/15 text-emerald-200';
                  indicator = '+';
                } else if (line.type === 'removed') {
                  rowBg = 'bg-rose-500/15 text-rose-200 line-through decoration-rose-400/60';
                  indicator = '-';
                }

                return (
                  <div
                    key={lIdx}
                    className={`flex items-stretch hover:brightness-110 transition-colors ${rowBg}`}
                  >
                    {/* Line Numbers */}
                    <div className="w-12 py-1 px-2 text-right text-[10px] text-[#6a6770] bg-[#121316] select-none shrink-0 border-r border-[#48454d]/20">
                      {line.oldLineNumber || ''}
                    </div>
                    <div className="w-12 py-1 px-2 text-right text-[10px] text-[#6a6770] bg-[#121316] select-none shrink-0 border-r border-[#48454d]/20">
                      {line.newLineNumber || ''}
                    </div>
                    {/* Indicator */}
                    <div className="w-6 py-1 text-center font-bold select-none shrink-0 opacity-70">
                      {indicator}
                    </div>
                    {/* Code Content */}
                    <div className="py-1 px-2 whitespace-pre flex-1 overflow-x-visible">
                      {line.content || ' '}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Side-by-Side Diff View */}
          {diffViewMode === 'split' && (
            <div className="grid grid-cols-2 divide-x divide-[#48454d]/30 max-h-[500px] overflow-y-auto custom-scrollbar">
              {/* Left: Original Content (from repository_files) */}
              <div className="overflow-x-auto">
                <div className="p-2 bg-[#161820] text-[10px] font-bold text-[#938f98] uppercase tracking-wider border-b border-[#48454d]/20 flex items-center justify-between">
                  <span>Original (Repository DB)</span>
                  <span>{currentFile.changeType === 'create' ? 'None (New File)' : ''}</span>
                </div>
                <div className="divide-y divide-[#48454d]/10">
                  {diffLines
                    .filter((l) => l.type !== 'added')
                    .map((line, idx) => (
                      <div
                        key={idx}
                        className={`flex items-stretch ${
                          line.type === 'removed' ? 'bg-rose-500/15 text-rose-200' : 'text-[#cac5ce]'
                        }`}
                      >
                        <div className="w-10 py-1 px-1.5 text-right text-[10px] text-[#6a6770] bg-[#121316] select-none shrink-0 border-r border-[#48454d]/20">
                          {line.oldLineNumber || ''}
                        </div>
                        <div className="py-1 px-2 whitespace-pre overflow-x-visible flex-1">
                          {line.content || ' '}
                        </div>
                      </div>
                    ))}
                  {currentFile.changeType === 'create' && (
                    <div className="p-8 text-center text-xs text-[#6a6770]">
                      No previous content exists for this new file.
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Proposed Content (Generated by AI) */}
              <div className="overflow-x-auto">
                <div className="p-2 bg-[#161820] text-[10px] font-bold text-emerald-400 uppercase tracking-wider border-b border-[#48454d]/20 flex items-center justify-between">
                  <span>Proposed Code</span>
                  <span>AI Generated</span>
                </div>
                <div className="divide-y divide-[#48454d]/10">
                  {diffLines
                    .filter((l) => l.type !== 'removed')
                    .map((line, idx) => (
                      <div
                        key={idx}
                        className={`flex items-stretch ${
                          line.type === 'added' ? 'bg-emerald-500/15 text-emerald-200' : 'text-[#cac5ce]'
                        }`}
                      >
                        <div className="w-10 py-1 px-1.5 text-right text-[10px] text-[#6a6770] bg-[#121316] select-none shrink-0 border-r border-[#48454d]/20">
                          {line.newLineNumber || ''}
                        </div>
                        <div className="py-1 px-2 whitespace-pre overflow-x-visible flex-1">
                          {line.content || ' '}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
