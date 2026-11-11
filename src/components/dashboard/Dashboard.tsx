'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { Repository } from '@/types';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/landing/EmptyState';

export interface DashboardProps {
  repositories: Repository[];
  isLoading?: boolean;
  onOpenUploadModal: () => void;
}

function getRepoUrl(repoId: string, tab = 'summary'): string {
  return `/?repo=${encodeURIComponent(repoId)}&tab=${encodeURIComponent(tab)}`;
}

function formatRelativeTime(dateInput: string): string {
  const timestamp = new Date(dateInput).getTime();
  if (Number.isNaN(timestamp)) return 'Recently';

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return 'Just now';

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;

  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y ago`;
}

function formatDateLabel(dateInput?: string | null): string {
  if (!dateInput) return 'Recently';
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getTimestamp(dateInput?: string | null): number {
  if (!dateInput) return -Infinity;
  const ts = new Date(dateInput).getTime();
  return Number.isNaN(ts) ? -Infinity : ts;
}

function renderStatusBadge(repo: Repository) {
  const status = repo.status;
  if (status === 'COMPLETED' || status === 'indexed') {
    return (
      <Badge variant="success" size="sm">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Indexed
      </Badge>
    );
  }

  if (status === 'FAILED' || status === 'error') {
    return (
      <Badge
        variant="outline"
        size="sm"
        className="bg-red-500/10 text-red-400 border-red-500/30"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Failed
      </Badge>
    );
  }

  const label = repo.stage || status || 'Indexing';
  return (
    <Badge variant="warning" size="sm">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      <span className="truncate max-w-[140px]">{label}</span>
    </Badge>
  );
}

export const Dashboard: React.FC<DashboardProps> = ({
  repositories,
  isLoading = false,
  onOpenUploadModal,
}) => {
  const { continueRepo, gridRepos } = useMemo(() => {
    const sorted = [...repositories].sort((a, b) => {
      const openDiff = getTimestamp(b.lastOpenedAt) - getTimestamp(a.lastOpenedAt);
      if (openDiff !== 0) return openDiff;
      return getTimestamp(b.createdAt) - getTimestamp(a.createdAt);
    });

    const latestOpened = sorted.find((r) => Boolean(r.lastOpenedAt)) || null;
    const remaining = latestOpened
      ? sorted.filter((r) => r.id !== latestOpened.id)
      : sorted;

    return {
      continueRepo: latestOpened,
      gridRepos: remaining,
    };
  }, [repositories]);

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-8">
        <div className="space-y-2">
          <div className="h-7 w-48 rounded-lg bg-[#1f1f23] animate-pulse" />
          <div className="h-4 w-72 rounded-md bg-[#1a1b1e] animate-pulse" />
        </div>

        <div className="h-44 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse" />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((item) => (
            <div
              key={item}
              className="h-44 rounded-2xl bg-[#1a1b1e] border border-[#48454d]/20 animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-12 sm:py-16 flex items-center justify-center">
        <EmptyState onOpenUpload={onOpenUploadModal} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-9">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-[#48454d]/20 pb-5">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-3xl font-heading font-semibold text-[#e3e2e6] tracking-tight">
            Workspace Dashboard
          </h1>
          <p className="text-sm text-[#938f98]">
            Pick up where you left off or open one of your indexed repositories.
          </p>
        </div>

        <div className="flex items-center gap-3 self-start sm:self-auto">
          <span className="text-xs font-mono text-[#cac5ce] bg-[#1a1b1e] border border-[#48454d]/30 px-3 py-1.5 rounded-lg">
            {repositories.length} {repositories.length === 1 ? 'Repository' : 'Repositories'}
          </span>
          <button
            type="button"
            onClick={onOpenUploadModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-xs font-semibold transition-colors shadow-sm cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>New Repository</span>
          </button>
        </div>
      </div>

      {/* Highlighted "Continue where you left off" Section */}
      {continueRepo && (
        <section className="space-y-3" aria-label="Continue where you left off">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-[#fbcfe8]">
            <span className="material-symbols-outlined text-[16px]">history</span>
            <span>Continue where you left off</span>
          </div>

          <div className="relative group rounded-2xl p-5 sm:p-7 bg-gradient-to-br from-[#231b24] via-[#1b1a20] to-[#1a1b1e] border border-[#fbcfe8]/35 hover:border-[#fbcfe8]/65 transition-all shadow-lg glow-pink-subtle">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
              <div className="flex items-start gap-4 min-w-0">
                <div className="w-12 h-12 rounded-xl bg-[#fbcfe8]/15 border border-[#fbcfe8]/30 flex items-center justify-center text-[#fbcfe8] shrink-0">
                  <span className="material-symbols-outlined text-[24px]">source</span>
                </div>

                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-lg sm:text-xl font-heading font-semibold text-[#e3e2e6] group-hover:text-white truncate">
                      {continueRepo.name}
                    </h2>
                    {renderStatusBadge(continueRepo)}
                  </div>

                  <p className="text-xs font-mono text-[#938f98] truncate">
                    {continueRepo.fullName}
                  </p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#cac5ce] pt-0.5">
                    <span
                      className="inline-flex items-center gap-1.5 text-[#fbcfe8] font-mono text-[11px]"
                      title={formatDateLabel(continueRepo.lastOpenedAt)}
                    >
                      <span className="material-symbols-outlined text-[14px]">schedule</span>
                      Opened {formatRelativeTime(continueRepo.lastOpenedAt!)}
                    </span>

                    {continueRepo.primaryLanguage && (
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-mono text-[#938f98]">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#b7c8e1]" />
                        {continueRepo.primaryLanguage}
                      </span>
                    )}

                    {continueRepo.fileCount > 0 && (
                      <span className="text-[11px] font-mono text-[#938f98]">
                        {continueRepo.fileCount} files
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0 flex items-center">
                <Link
                  href={getRepoUrl(continueRepo.id, 'summary')}
                  className="after:absolute after:inset-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#fbcfe8] hover:bg-[#f9a8d4] text-[#3d1729] text-sm font-semibold transition-all shadow-sm w-full md:w-auto"
                >
                  <span>Resume</span>
                  <span className="material-symbols-outlined text-[18px] group-hover:translate-x-0.5 transition-transform">
                    arrow_forward
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Repository Grid */}
      <section className="space-y-3" aria-label="Repositories">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-[#938f98]">
            {continueRepo ? 'All Other Repositories' : 'Your Repositories'}
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {gridRepos.map((repo) => {
            const hasLastOpened = Boolean(repo.lastOpenedAt);
            const timeLabel = hasLastOpened
              ? `Opened ${formatRelativeTime(repo.lastOpenedAt!)}`
              : `Created ${formatDateLabel(repo.createdAt)}`;
            const exactDateTitle = hasLastOpened
              ? `Last opened ${formatDateLabel(repo.lastOpenedAt)}`
              : `Created ${formatDateLabel(repo.createdAt)}`;

            return (
              <Link
                key={repo.id}
                href={getRepoUrl(repo.id, 'summary')}
                className="group rounded-2xl p-5 bg-[#1a1b1e] hover:bg-[#1f1f23] border border-[#48454d]/25 hover:border-[#fbcfe8]/40 transition-all flex flex-col justify-between gap-4 min-h-[168px] shadow-sm"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-[#292a2d] border border-[#48454d]/40 group-hover:border-[#fbcfe8]/30 flex items-center justify-center text-[#b7c8e1] group-hover:text-[#fbcfe8] transition-colors shrink-0">
                        <span className="material-symbols-outlined text-[18px]">source</span>
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-heading font-semibold text-[#e3e2e6] group-hover:text-white truncate">
                          {repo.name}
                        </h3>
                        <p className="text-[11px] font-mono text-[#938f98] truncate">
                          {repo.fullName}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {renderStatusBadge(repo)}
                    {repo.primaryLanguage && (
                      <Badge variant="default" size="sm">
                        {repo.primaryLanguage}
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="pt-3 border-t border-[#48454d]/20 flex items-center justify-between gap-2 text-[11px] font-mono text-[#938f98]">
                  <span className="truncate" title={exactDateTitle}>
                    {timeLabel}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[#cac5ce] group-hover:text-[#fbcfe8] transition-colors shrink-0">
                    <span>Open</span>
                    <span className="material-symbols-outlined text-[15px] group-hover:translate-x-0.5 transition-transform">
                      arrow_forward
                    </span>
                  </span>
                </div>
              </Link>
            );
          })}

          {/* New Repository Card */}
          <button
            type="button"
            onClick={onOpenUploadModal}
            className="group rounded-2xl p-5 bg-[#1a1b1e]/40 hover:bg-[#1f1f23]/90 border border-dashed border-[#48454d]/50 hover:border-[#fbcfe8]/55 transition-all flex flex-col items-center justify-center text-center gap-3 min-h-[168px] cursor-pointer"
          >
            <div className="w-11 h-11 rounded-xl bg-[#292a2d] border border-[#fbcfe8]/25 group-hover:border-[#fbcfe8]/50 flex items-center justify-center text-[#fbcfe8] group-hover:scale-105 transition-transform">
              <span className="material-symbols-outlined text-[22px]">add</span>
            </div>
            <div className="space-y-1">
              <div className="text-sm font-heading font-semibold text-[#e3e2e6] group-hover:text-white">
                New repository
              </div>
              <p className="text-xs text-[#938f98] max-w-[200px]">
                Upload a ZIP archive or import from GitHub
              </p>
            </div>
          </button>
        </div>
      </section>
    </div>
  );
};

