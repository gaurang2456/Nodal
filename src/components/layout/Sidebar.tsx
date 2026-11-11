'use client';

import React from 'react';
import Link from 'next/link';
import { TabType } from '@/types';

export interface SidebarProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  onNewChat?: () => void;
  onOpenUploadModal?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  onNewChat,
  onOpenUploadModal
}) => {
  const navItems: { id: TabType; label: string; icon: string }[] = [
    { id: 'summary', label: 'Summary', icon: 'description' },
    { id: 'graph', label: 'Graph', icon: 'hub' },
    { id: 'files', label: 'Files', icon: 'folder_open' },
    { id: 'analysis', label: 'Feature Planner', icon: 'architecture' }
  ];

  return (
    <aside className="fixed left-0 top-14 bottom-0 w-[260px] bg-[#1a1b1e] z-40 flex flex-col border-r border-[#48454d]/20 select-none">
      {/* Home Navigation */}
      <div className="px-6 pt-5 pb-2 flex flex-col gap-1">
        <Link
          href="/"
          className="flex items-center px-3 py-2 rounded-lg text-sm transition-colors text-left font-medium text-[#cac5ce] hover:bg-[#292a2d] hover:text-[#e3e2e6] cursor-pointer"
        >
          <span className="material-symbols-outlined mr-3 text-[18px]">
            home
          </span>
          Home
        </Link>
      </div>

      {/* Overview Navigation */}
      <div className="px-6 py-4 flex flex-col gap-4">
        <div className="text-[11px] font-mono text-[#938f98] uppercase tracking-widest font-semibold px-1">
          Overview
        </div>
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`flex items-center px-3 py-2 rounded-lg text-sm transition-colors text-left font-medium cursor-pointer ${
                  isActive
                    ? 'bg-[#70485c] text-[#fdf2f8] font-medium'
                    : 'text-[#cac5ce] hover:bg-[#292a2d] hover:text-[#e3e2e6]'
                }`}
              >
                <span className="material-symbols-outlined mr-3 text-[18px]">
                  {item.icon}
                </span>
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* AI Assistant Section */}
      <div className="p-6 pt-0 flex flex-col gap-4">
        <div className="text-[11px] font-mono text-[#938f98] uppercase tracking-widest font-semibold px-1">
          AI Assistant
        </div>
        <button
          onClick={onNewChat}
          className="flex items-center justify-center w-full px-4 py-2 bg-[#fbcfe8] text-[#3d1729] rounded text-sm font-medium hover:bg-[#f9a8d4] active:scale-[0.99] transition-colors shadow-sm cursor-pointer"
        >
          <span className="material-symbols-outlined mr-2 text-[18px]">add</span>
          New Chat
        </button>
      </div>

      {/* Bottom Section */}
      <div className="mt-auto p-6 flex flex-col gap-1 border-t border-[#48454d]/20">
        <button
          onClick={onOpenUploadModal}
          className="flex items-center px-3 py-2 rounded text-sm text-[#cac5ce] hover:bg-[#292a2d] hover:text-[#e3e2e6] transition-colors text-left cursor-pointer"
        >
          <span className="material-symbols-outlined mr-3 text-[18px]">sync</span>
          Scan Repository
        </button>
        <button
          onClick={() => onTabChange('settings')}
          className={`flex items-center px-3 py-2 rounded text-sm transition-colors text-left cursor-pointer ${
            activeTab === 'settings'
              ? 'bg-[#70485c] text-[#fdf2f8]'
              : 'text-[#cac5ce] hover:bg-[#292a2d] hover:text-[#e3e2e6]'
          }`}
        >
          <span className="material-symbols-outlined mr-3 text-[18px]">settings</span>
          Settings
        </button>
      </div>
    </aside>
  );
};
