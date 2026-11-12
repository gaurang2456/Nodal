'use client';

import React from 'react';
import { ChatMessage as ChatMessageType, FileCitation } from '@/types';
import { ReferencedFileBadge } from './ReferencedFileBadge';
import { Badge } from '@/components/ui/Badge';
import { Sparkles, User, Copy, Check, ShieldCheck, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export interface ChatMessageProps {
  message: ChatMessageType;
  onCitationClick: (citation: FileCitation) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  onCitationClick
}) => {
  const [copied, setCopied] = React.useState(false);
  const isAssistant = message.sender === 'assistant';

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`flex items-start gap-3 p-4 rounded-2xl transition-all ${
        isAssistant
          ? 'bg-slate-900/70 border border-slate-800/80 shadow-md shadow-blue-500/5'
          : 'bg-blue-600/10 border border-blue-500/20 text-slate-100 ml-auto max-w-2xl'
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
          isAssistant
            ? 'bg-gradient-to-tr from-blue-600 to-indigo-500 text-white border-blue-500/30 shadow-md shadow-blue-500/20'
            : 'bg-slate-800 text-slate-300 border-slate-700'
        }`}
      >
        {isAssistant ? <Sparkles className="w-4 h-4" /> : <User className="w-4 h-4" />}
      </div>

      {/* Message Content */}
      <div className="flex-1 space-y-3 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-200 font-mono">
              {isAssistant ? 'Nodal AI' : 'You'}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">{message.timestamp}</span>
          </div>

          {isAssistant && message.confidenceScore && (
            <Badge variant="success" size="sm" className="font-mono text-[10px]">
              <ShieldCheck className="w-3 h-3" />
              {Math.round(message.confidenceScore * 100)}% Confidence Match
            </Badge>
          )}
        </div>

        {/* Text Answer */}
        <div className="text-xs sm:text-sm leading-relaxed text-slate-200 whitespace-pre-wrap font-sans space-y-2">
          {message.content}
          {message.isStreaming && (
            <span className="inline-block w-2 h-4 bg-blue-400 animate-pulse ml-1 align-middle" />
          )}
        </div>

        {/* Citations List */}
        {isAssistant && message.citations && message.citations.length > 0 && (
          <div className="pt-3 border-t border-slate-800/80 space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-mono text-slate-400 uppercase tracking-wider">
              <FileText className="w-3.5 h-3.5 text-blue-400" />
              Referenced Source Files ({message.citations.length}):
            </div>
            <div className="flex flex-wrap gap-2">
              {message.citations.map((citation) => (
                <ReferencedFileBadge
                  key={citation.filename}
                  citation={citation}
                  onClick={onCitationClick}
                />
              ))}
            </div>
          </div>
        )}

        {/* Action bar for assistant messages */}
        {isAssistant && !message.isStreaming && (
          <div className="pt-2 flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              leftIcon={copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              className="text-[11px] h-7"
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
