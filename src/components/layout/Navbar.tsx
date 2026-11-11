'use client';

import React, { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Repository } from '@/types';
import { createClient } from '@/lib/supabase/client';
import { GitHubConnectionCard } from '@/components/github/GitHubConnectionCard';

export interface NavbarProps {
  repositories: Repository[];
  activeRepo: Repository | null;
  onSelectRepo: (repo: Repository) => void;
  onOpenUploadModal: () => void;
  onNavigateHome: () => void;
  canGoBack?: boolean;
  onGoBack?: () => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onToggleRightPanel?: () => void;
  onDeleteRepo?: (repoId: string, repoName: string) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  repositories,
  activeRepo,
  onSelectRepo,
  onOpenUploadModal,
  onNavigateHome,
  canGoBack = false,
  onGoBack,
  searchQuery,
  onSearchChange,
  theme,
  onToggleTheme,
  onToggleRightPanel,
  onDeleteRepo,
}) => {
  const router = useRouter();
  const [isRepoDropdownOpen, setIsRepoDropdownOpen] = useState(false);
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [githubNotification, setGithubNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  const supabase = createClient();

  useEffect(() => {
    // Check for GitHub OAuth callback query parameters
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('github_connected') === 'true') {
        setGithubNotification({
          type: 'success',
          message: 'GitHub account connected successfully! Authorized for repository operations.',
        });
        window.history.replaceState({}, '', window.location.pathname);
      } else if (urlParams.get('github_error')) {
        const err = urlParams.get('github_error');
        const safeMsg =
          err === 'oauth_denied'
            ? 'GitHub authorization request was cancelled.'
            : 'Could not connect GitHub account. Please try again.';
        setGithubNotification({
          type: 'error',
          message: safeMsg,
        });
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  }, []);

  useEffect(() => {
    // Load authenticated user info
    const loadUser = async () => {
      const { data } = await supabase.auth.getUser();
      if (data?.user?.email) {
        setUserEmail(data.user.email);
      }
    };
    loadUser();
  }, [supabase]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsRepoDropdownOpen(false);
        setIsBranchDropdownOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) {
        setIsProfileDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
      router.push('/login');
    } catch (err) {
      console.error('Logout error:', err);
      router.push('/login');
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 h-14 bg-[#121316]/90 backdrop-blur-xl border-b border-[#48454d]/20 z-50 flex items-center px-4 sm:px-6 gap-3 sm:gap-6 justify-between select-none">
      {/* Left: Brand & Repo/Branch Selectors */}
      <div className="flex items-center gap-3 sm:gap-4 min-w-0" ref={dropdownRef}>
        {/* Logo & Brand */}
        <Link
          href="/"
          onClick={() => {
            setIsRepoDropdownOpen(false);
            setIsBranchDropdownOpen(false);
            onNavigateHome();
          }}
          className="flex items-center gap-2.5 sm:min-w-[212px] text-left focus:outline-none group cursor-pointer shrink-0"
        >
          <div className="w-7 h-7 rounded-lg bg-[#292a2d] border border-[#fbcfe8]/30 flex items-center justify-center text-[#fbcfe8] group-hover:scale-105 transition-transform">
            <span className="material-symbols-outlined text-[17px]">hub</span>
          </div>
          <span className="font-heading font-semibold text-base text-[#e3e2e6] tracking-tight group-hover:text-white transition-colors">
            CodeGraph
          </span>
        </Link>

        {/* Back Navigation Button */}
        {onGoBack && (
          <button
            onClick={onGoBack}
            disabled={!canGoBack}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1f1f23] hover:bg-[#292a2d] rounded-lg border border-[#48454d]/30 text-xs font-mono text-[#cac5ce] hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:hover:bg-[#1f1f23] disabled:hover:text-[#cac5ce] disabled:cursor-not-allowed shadow-sm"
            title={canGoBack ? 'Go back to last opened view' : 'No previous view'}
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            <span>Back</span>
          </button>
        )}

        {/* Repository Dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setIsRepoDropdownOpen(!isRepoDropdownOpen);
              setIsBranchDropdownOpen(false);
            }}
            className="flex items-center gap-2 px-3 py-1.5 bg-[#1f1f23] hover:bg-[#292a2d] rounded-lg border border-[#48454d]/30 text-xs font-medium text-[#e3e2e6] transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px] text-[#b7c8e1]">source</span>
            <span className="max-w-[160px] truncate">
              {activeRepo ? activeRepo.name : 'Select Repository'}
            </span>
            <span className="material-symbols-outlined text-[14px] text-[#938f98]">expand_more</span>
          </button>

          {isRepoDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-64 bg-[#1a1b1e] rounded-xl border border-[#48454d]/40 p-1.5 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-1.5 text-[10px] font-mono text-[#938f98] uppercase tracking-wider">
                My Repositories ({repositories.length})
              </div>
              <div className="space-y-0.5 max-h-56 overflow-y-auto">
                {repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className={`group/repo w-full px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors ${
                      activeRepo?.id === repo.id
                        ? 'bg-[#70485c]/30 text-[#fbcfe8] font-medium border border-[#fbcfe8]/20'
                        : 'text-[#cac5ce] hover:bg-[#292a2d] hover:text-white'
                    }`}
                  >
                    <button
                      onClick={() => {
                        onSelectRepo(repo);
                        setIsRepoDropdownOpen(false);
                      }}
                      className="flex items-center gap-2 truncate flex-1 text-left cursor-pointer focus:outline-none"
                    >
                      <span className="material-symbols-outlined text-[15px] text-[#b7c8e1] shrink-0">source</span>
                      <span className="truncate">{repo.name}</span>
                    </button>
                    <div className="flex items-center gap-1 shrink-0 ml-1.5">
                      {activeRepo?.id === repo.id && (
                        <span className="material-symbols-outlined text-[14px] text-[#fbcfe8]">check</span>
                      )}
                      {onDeleteRepo && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              window.confirm(
                                `Delete "${repo.name}" from your history? All associated graph data, files, and feature plans will be removed.`
                              )
                            ) {
                              onDeleteRepo(repo.id, repo.name);
                            }
                          }}
                          title={`Delete ${repo.name}`}
                          className="opacity-0 group-hover/repo:opacity-100 hover:text-red-400 p-0.5 rounded transition-all cursor-pointer text-[#938f98]"
                        >
                          <span className="material-symbols-outlined text-[15px]">delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {repositories.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[#938f98]">
                    No repositories found.
                  </div>
                )}
              </div>

              <div className="p-1 border-t border-[#48454d]/30 mt-1">
                <button
                  onClick={() => {
                    setIsRepoDropdownOpen(false);
                    onOpenUploadModal();
                  }}
                  className="w-full py-1.5 px-3 rounded-lg text-xs font-mono font-medium text-[#fbcfe8] bg-[#70485c]/20 hover:bg-[#70485c]/40 border border-[#fbcfe8]/30 flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">add</span>
                  <span>Add Repository</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Branch Dropdown */}
        {activeRepo && (
          <div className="relative hidden sm:block">
            <button
              onClick={() => {
                setIsBranchDropdownOpen(!isBranchDropdownOpen);
                setIsRepoDropdownOpen(false);
              }}
              className="flex items-center gap-2 px-3 py-1.5 bg-[#1f1f23] hover:bg-[#292a2d] rounded-lg border border-[#48454d]/30 text-xs font-medium text-[#e3e2e6] transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px] text-[#938f98]">account_tree</span>
              <span className="font-mono text-xs">{activeRepo.branch || 'main'}</span>
              <span className="material-symbols-outlined text-[14px] text-[#938f98]">expand_more</span>
            </button>

            {isBranchDropdownOpen && (
              <div className="absolute top-full left-0 mt-2 w-44 bg-[#1a1b1e] rounded-xl border border-[#48454d]/40 p-1.5 shadow-2xl z-50">
                <div className="px-3 py-1.5 text-[10px] font-mono text-[#938f98] uppercase tracking-wider">
                  Branches
                </div>
                <div className="space-y-0.5">
                  {['main', 'develop', 'release/v1.0'].map((branch) => (
                    <button
                      key={branch}
                      onClick={() => setIsBranchDropdownOpen(false)}
                      className="w-full text-left px-3 py-1.5 rounded-lg text-xs font-mono text-[#cac5ce] hover:bg-[#292a2d] hover:text-white flex items-center justify-between"
                    >
                      <span>{branch}</span>
                      {branch === (activeRepo.branch || 'main') && (
                        <span className="material-symbols-outlined text-[14px] text-[#fbcfe8]">check</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: Actions & User Profile */}
      <div className="flex items-center gap-3 min-w-fit">
        <button
          onClick={onToggleTheme}
          title="Toggle Theme"
          className="p-1.5 hover:bg-[#292a2d] rounded-lg transition-colors text-[#cac5ce] hover:text-white cursor-pointer"
        >
          <span className="material-symbols-outlined text-[20px]">
            {theme === 'dark' ? 'dark_mode' : 'light_mode'}
          </span>
        </button>

        {/* User Account Dropdown */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
            className="w-8 h-8 rounded-full bg-[#fbcfe8] flex items-center justify-center text-[#3d1729] font-medium shadow-sm cursor-pointer hover:bg-[#f9a8d4] transition-colors focus:outline-none"
            title={userEmail || 'Account'}
          >
            <span className="material-symbols-outlined text-[18px]">person</span>
          </button>

          {isProfileDropdownOpen && (
            <div className="absolute top-full right-0 mt-2 w-72 bg-[#1a1b1e] rounded-2xl border border-[#48454d]/40 p-2 shadow-2xl z-50 animate-in fade-in zoom-in-95 duration-100 space-y-2">
              <div className="px-3 py-2 border-b border-[#48454d]/25">
                <div className="text-[10px] font-mono text-[#938f98] uppercase tracking-wider">Signed in as</div>
                <div className="text-xs font-mono font-medium text-white truncate">{userEmail || 'User Account'}</div>
              </div>

              {/* GitHub Connection Section */}
              <div className="px-3 py-2 border-b border-[#48454d]/25">
                <GitHubConnectionCard compact />
              </div>

              <div className="p-1">
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono text-red-300 hover:bg-red-500/15 hover:text-red-200 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">logout</span>
                  <span>Log Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* GitHub Callback Toast Notification */}
      {githubNotification && (
        <div
          className={`fixed top-16 right-6 z-50 max-w-sm p-3.5 rounded-2xl border shadow-2xl backdrop-blur-xl flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-4 duration-200 ${
            githubNotification.type === 'success'
              ? 'bg-[#0f241a]/95 border-emerald-500/40 text-emerald-200'
              : 'bg-[#291215]/95 border-rose-500/40 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="material-symbols-outlined text-[18px]">
              {githubNotification.type === 'success' ? 'check_circle' : 'error'}
            </span>
            <span>{githubNotification.message}</span>
          </div>
          <button
            onClick={() => setGithubNotification(null)}
            className="text-white/60 hover:text-white transition-colors cursor-pointer p-1"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        </div>
      )}
    </header>
  );
};
