'use client';

import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { GitHubConnectionStatus } from '@/types';
import { useGitHubConnection, invalidateGitHubConnection } from '@/lib/api/queries';

export interface GitHubConnectionCardProps {
  initialStatus?: GitHubConnectionStatus | null;
  onConnectionChange?: (status: GitHubConnectionStatus) => void;
  compact?: boolean;
}

export const GitHubConnectionCard: React.FC<GitHubConnectionCardProps> = ({
  initialStatus,
  onConnectionChange,
  compact = false,
}) => {
  const queryClient = useQueryClient();
  const { data: queryStatus, isLoading: isQueryLoading } = useGitHubConnection();
  const status: GitHubConnectionStatus | null = queryStatus ?? initialStatus ?? null;
  const fetching = isQueryLoading && !initialStatus && queryStatus === undefined;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supabase = createClient();

  useEffect(() => {
    if (queryStatus) {
      onConnectionChange?.(queryStatus);
    }
  }, [queryStatus, onConnectionChange]);

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: `${origin}/auth/github/callback`,
          scopes: 'repo',
        },
      });

      if (oauthError) {
        setError('GitHub authorization could not be initiated.');
        setLoading(false);
      }
    } catch {
      setError('Failed to initiate GitHub connection.');
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Are you sure you want to disconnect your GitHub account from Nodal?')) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/github/connection', {
        method: 'DELETE',
      });

      if (res.ok) {
        const newStatus: GitHubConnectionStatus = { connected: false };
        queryClient.setQueryData(['github-connection'], newStatus);
        await invalidateGitHubConnection(queryClient);
        onConnectionChange?.(newStatus);
      } else {
        setError('Failed to disconnect GitHub account. Please try again.');
      }
    } catch {
      setError('Connection error while disconnecting GitHub.');
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return (
      <div className="p-3 rounded-2xl bg-[#17181c] border border-[#48454d]/25 animate-pulse flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#24252a]" />
          <div className="h-3 w-28 bg-[#24252a] rounded" />
        </div>
        <div className="h-6 w-16 bg-[#24252a] rounded-lg" />
      </div>
    );
  }

  const isConnected = !!status?.connected;

  if (compact) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[#e3e2e6]" viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span className="text-xs font-mono font-medium text-[#e3e2e6]">GitHub</span>
          </div>
          {isConnected ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Connected
            </span>
          ) : (
            <span className="text-[10px] font-mono text-[#938f98]">Not connected</span>
          )}
        </div>

        {isConnected ? (
          <div className="flex items-center justify-between p-2 rounded-xl bg-[#16171b] border border-[#48454d]/25">
            <div className="flex items-center gap-2 min-w-0">
              {status.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={status.avatarUrl}
                  alt={status.githubLogin || 'GitHub User'}
                  className="w-5 h-5 rounded-full border border-[#48454d]/40 shrink-0"
                />
              ) : (
                <div className="w-5 h-5 rounded-full bg-[#292a2d] flex items-center justify-center text-[10px] font-mono text-white">
                  @
                </div>
              )}
              <span className="text-xs font-mono text-white truncate">
                @{status.githubLogin}
              </span>
            </div>
            <button
              onClick={handleDisconnect}
              disabled={loading}
              className="text-[10px] font-mono text-rose-400 hover:text-rose-300 transition-colors cursor-pointer px-2 py-1 rounded-lg hover:bg-rose-500/10 disabled:opacity-50"
            >
              {loading ? '...' : 'Disconnect'}
            </button>
          </div>
        ) : (
          <button
            onClick={handleConnect}
            disabled={loading}
            className="w-full py-1.5 px-3 rounded-xl bg-[#292a2d] hover:bg-[#34353a] border border-[#48454d]/40 text-xs font-mono text-white flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
          >
            <span className="material-symbols-outlined text-[15px]">link</span>
            <span>{loading ? 'Connecting...' : 'Connect GitHub'}</span>
          </button>
        )}

        {error && (
          <p className="text-[10px] font-mono text-rose-300 leading-tight">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 rounded-2xl bg-[#13151b] border border-[#48454d]/30 shadow-lg space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#24252c] border border-[#48454d]/40 flex items-center justify-center text-white">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
          </div>
          <div>
            <div className="text-xs font-mono font-bold text-white flex items-center gap-2">
              <span>GitHub Account</span>
              {isConnected && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 text-[9px] font-mono font-semibold">
                  Connected
                </span>
              )}
            </div>
            <div className="text-[11px] font-mono text-[#938f98]">
              {isConnected
                ? `Authorized for Pull Request workflows`
                : 'Connect to authorize pull requests and commits'}
            </div>
          </div>
        </div>

        {isConnected ? (
          <button
            onClick={handleDisconnect}
            disabled={loading}
            className="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-mono font-medium transition-colors cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Disconnecting...' : 'Disconnect'}
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={loading}
            className="px-3.5 py-1.5 rounded-xl bg-[#292a2d] hover:bg-[#38393e] border border-[#fbcfe8]/30 text-white text-xs font-mono font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 shadow-sm"
          >
            <span className="material-symbols-outlined text-[16px]">link</span>
            <span>{loading ? 'Connecting...' : 'Connect GitHub'}</span>
          </button>
        )}
      </div>

      {isConnected && (
        <div className="p-2.5 rounded-xl bg-[#0e0f12] border border-[#48454d]/20 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2.5">
            {status.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={status.avatarUrl}
                alt={status.githubLogin || 'GitHub'}
                className="w-6 h-6 rounded-full border border-[#48454d]/50"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-[#24252a] text-white flex items-center justify-center text-[11px]">
                @
              </div>
            )}
            <span className="text-white font-medium">@{status.githubLogin}</span>
          </div>
          {status.connectedAt && (
            <span className="text-[10px] text-[#6e6a75]">
              Connected {new Date(status.connectedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs font-mono">
          {error}
        </div>
      )}
    </div>
  );
};
