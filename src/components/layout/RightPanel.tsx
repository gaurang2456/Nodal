'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Repository, ChatMessage as ChatMessageType, FileCitation } from '@/types';

export interface RightPanelProps {
  activeRepo: Repository;
  isOpen: boolean;
  onClose: () => void;
  onSelectFile?: (filename: string, startLine?: number, endLine?: number) => void;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  activeRepo,
  isOpen,
  onClose,
  onSelectFile
}) => {
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load chat history for active repository
  useEffect(() => {
    let isMounted = true;
    async function loadHistory() {
      if (!activeRepo?.id) return;
      try {
        const res = await fetch(`/api/repositories/${activeRepo.id}/chat`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.messages) {
            setMessages(
              data.messages.map((m: any) => ({
                id: m.id,
                sender: m.sender,
                content: m.content,
                timestamp: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                citations: typeof m.citations === 'string' ? JSON.parse(m.citations) : m.citations,
                confidenceScore: m.confidence_score,
              }))
            );
          }
        }
      } catch (err) {
        console.error('Failed to load chat history:', err);
      }
    }

    loadHistory();
    return () => {
      isMounted = false;
    };
  }, [activeRepo?.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isGenerating]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || inputQuery).trim();
    if (!text || isGenerating || !activeRepo?.id) return;

    const userMsg: ChatMessageType = {
      id: `user-${Date.now()}`,
      sender: 'user',
      content: text,
      timestamp: 'Just now'
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsGenerating(true);

    try {
      const res = await fetch(`/api/repositories/${activeRepo.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to get response from AI');
      }

      const data = await res.json();
      const assistantMsg: ChatMessageType = {
        id: `ai-${Date.now()}`,
        sender: 'assistant',
        content: data.answer,
        timestamp: 'Just now',
        confidenceScore: data.confidenceScore || 0.95,
        citations: data.citations || [],
        implementationPlan: data.implementationPlan,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      console.error('Chat error:', err);
      const errorMsg: ChatMessageType = {
        id: `err-${Date.now()}`,
        sender: 'assistant',
        content: `Error: ${err?.message || 'Failed to process request. Please ensure OPENAI_API_KEY is configured in .env.local and database is connected.'}`,
        timestamp: 'Just now',
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCitationClick = (citation: FileCitation) => {
    if (onSelectFile) {
      onSelectFile(citation.path || citation.filename, citation.startLine, citation.endLine);
    }
  };

  if (!isOpen) return null;

  return (
    <aside className="fixed right-0 top-14 bottom-0 w-[320px] bg-[#1a1b1e] border-l border-[#48454d]/25 z-40 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="p-3.5 border-b border-[#48454d]/20 flex items-center justify-between bg-[#1f1f23]/60">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-[#fbcfe8]/10 text-[#fbcfe8] flex items-center justify-center">
            <span className="material-symbols-outlined text-[16px]">smart_toy</span>
          </div>
          <span className="font-heading font-semibold text-xs text-[#e3e2e6]">AI Assistant</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#292a2d] text-[#b7c8e1]">
            RAG Active
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-[#938f98] hover:text-[#e3e2e6] transition-colors p-1 rounded-md hover:bg-[#292a2d]"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>

      {/* Messages Stream */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-4">
        {messages.length === 0 && (
          <div className="py-8 text-center space-y-2">
            <div className="w-10 h-10 rounded-full bg-[#292a2d] text-[#fbcfe8] flex items-center justify-center mx-auto mb-2">
              <span className="material-symbols-outlined text-[20px]">chat</span>
            </div>
            <p className="text-xs text-[#e3e2e6] font-medium">Ask anything about {activeRepo.name}</p>
            <p className="text-[11px] text-[#938f98]">
              Answers are generated using semantic embeddings and pgvector similarity search.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className="space-y-2 animate-in fade-in duration-200">
            {msg.sender === 'user' ? (
              <div className="bg-[#292a2d] text-[#e3e2e6] p-2.5 rounded-xl rounded-tr-none text-xs ml-4 border border-[#48454d]/20">
                {msg.content}
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#fbcfe8] uppercase tracking-wider">
                  <span className="material-symbols-outlined text-[14px]">terminal</span>
                  <span>Nodal AI</span>
                </div>

                <div className="text-xs text-[#e3e2e6] leading-relaxed bg-[#111316]/50 p-2.5 rounded-xl border border-[#48454d]/15 whitespace-pre-wrap">
                  {msg.content}
                </div>

                {/* Real Citations */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[10px] font-mono text-[#938f98] uppercase tracking-wider flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">link</span>
                      Verified Sources:
                    </span>
                    <div className="space-y-1">
                      {msg.citations.map((c, i) => (
                        <div
                          key={i}
                          onClick={() => handleCitationClick(c)}
                          className="p-2 bg-[#1f1f23] hover:bg-[#292a2d] border border-[#48454d]/20 rounded-lg text-xs flex flex-col gap-0.5 cursor-pointer transition-colors group"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[#fbcfe8] text-[11px] group-hover:underline truncate">
                              {c.filename}
                            </span>
                            <span className="text-[10px] font-mono text-[#b7c8e1] bg-[#111316] px-1.5 py-0.5 rounded">
                              {c.lineRange || (c.startLine ? `L${c.startLine}-L${c.endLine}` : 'ref')}
                            </span>
                          </div>
                          {c.snippet && (
                            <p className="text-[10px] text-[#938f98] font-mono line-clamp-1 truncate">
                              {c.snippet}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Implementation Plan */}
                {msg.implementationPlan && msg.implementationPlan.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-[#48454d]/20">
                    <span className="text-xs font-semibold text-[#e3e2e6] flex items-center gap-1">
                      <span className="material-symbols-outlined text-[#fbcfe8] text-[14px]">task_alt</span>
                      Implementation Plan
                    </span>
                    <div className="space-y-1.5">
                      {msg.implementationPlan.map((step) => (
                        <div
                          key={step.step}
                          onClick={() => onSelectFile && onSelectFile(step.targetFile)}
                          className="p-2 bg-[#1f1f23] hover:bg-[#292a2d] border border-[#48454d]/20 rounded-lg text-xs flex items-center justify-between cursor-pointer transition-colors group"
                        >
                          <div className="flex items-center gap-2">
                            <span className="w-4 h-4 rounded-full bg-[#292a2d] text-[#fbcfe8] text-[10px] font-mono flex items-center justify-center font-bold">
                              {step.step}
                            </span>
                            <span className="text-xs text-[#cac5ce] group-hover:text-white truncate max-w-[180px]">
                              {step.title}
                            </span>
                          </div>
                          <span className="text-[10px] font-mono text-[#938f98] group-hover:text-[#fbcfe8]">
                            {step.targetFile.split('/').pop()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {isGenerating && (
          <div className="flex items-center gap-2 text-xs text-[#fbcfe8] font-mono p-2 bg-[#1f1f23] rounded-lg animate-pulse">
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            Retrieving chunks & generating response...
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="p-3 border-t border-[#48454d]/20 bg-[#1a1b1e]">
        <div className="relative flex items-center">
          <textarea
            rows={2}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask anything about architecture, classes, auth, endpoints..."
            className="w-full bg-[#121316] border border-[#48454d]/30 focus:border-[#fbcfe8]/60 rounded-xl p-2.5 pr-10 text-xs text-[#e3e2e6] placeholder:text-[#938f98] outline-none resize-none transition-colors"
          />
          <button
            onClick={() => handleSend()}
            disabled={!inputQuery.trim() || isGenerating}
            className="absolute right-2.5 bottom-2.5 p-1.5 bg-[#fbcfe8] text-[#3d1729] rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#f9a8d4] transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]">send</span>
          </button>
        </div>
      </div>
    </aside>
  );
};
