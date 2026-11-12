'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Repository, ChatMessage as ChatMessageType, FileCitation } from '@/types';
import { ChatMessage } from './ChatMessage';
import { PromptSuggestions } from './PromptSuggestions';
import { FileViewerModal } from './FileViewerModal';
import { Button } from '@/components/ui/Button';
import { Send, Sparkles, MessageSquareCode, Trash2, Bot } from 'lucide-react';

export interface ChatInterfaceProps {
  activeRepo: Repository;
}

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ activeRepo }) => {
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [inputQuery, setInputQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedCitation, setSelectedCitation] = useState<FileCitation | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    let isMounted = true;
    async function loadHistory() {
      if (!activeRepo?.id) return;
      try {
        const res = await fetch(`/api/repositories/${activeRepo.id}/chat`);
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.messages && data.messages.length > 0) {
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
          } else if (isMounted) {
            setMessages([
              {
                id: 'welcome-1',
                sender: 'assistant',
                content: `Hello! I have indexed **${activeRepo.name}**. You can ask me anything about its architecture, authentication flow, database schemas, REST endpoints, or business logic.`,
                timestamp: 'Just now',
                confidenceScore: 0.99
              }
            ]);
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
  }, [activeRepo?.id, activeRepo?.name]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendQuery = async (queryText?: string) => {
    const text = (queryText || inputQuery).trim();
    if (!text || isGenerating || !activeRepo?.id) return;

    const userMessageId = `user-${Date.now()}`;
    const userMessage: ChatMessageType = {
      id: userMessageId,
      sender: 'user',
      content: text,
      timestamp: 'Just now'
    };

    setMessages((prev) => [...prev, userMessage]);
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
      const assistantMessage: ChatMessageType = {
        id: `assistant-${Date.now()}`,
        sender: 'assistant',
        content: data.answer,
        timestamp: 'Just now',
        citations: data.citations || [],
        confidenceScore: data.confidenceScore || 0.95,
        implementationPlan: data.implementationPlan
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: any) {
      console.error('Chat query error:', err);
      const errorMsg: ChatMessageType = {
        id: `err-${Date.now()}`,
        sender: 'assistant',
        content: `Error: ${err?.message || 'Failed to query RAG engine.'}`,
        timestamp: 'Just now',
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClearHistory = () => {
    setMessages([
      {
        id: `welcome-${Date.now()}`,
        sender: 'assistant',
        content: `Chat history cleared. What would you like to explore in **${activeRepo.name}**?`,
        timestamp: 'Just now',
        confidenceScore: 0.99
      }
    ]);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] min-h-[500px] rounded-2xl bg-[#111316] border border-[#48454d]/30 shadow-2xl overflow-hidden">
      {/* Chat header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#48454d]/20 bg-[#1a1b1e]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-[#292a2d] border border-[#fbcfe8]/20 flex items-center justify-center text-[#fbcfe8]">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#e3e2e6] flex items-center gap-2">
              Nodal AI Assistant
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-[#fbcfe8]/10 text-[#fbcfe8] border border-[#fbcfe8]/20">
                {activeRepo.name}
              </span>
            </h3>
            <p className="text-[11px] text-[#938f98]">Vector RAG • OpenAI embeddings • pgvector</p>
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearHistory}
          className="text-[#938f98] hover:text-[#e3e2e6]"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            onCitationClick={(citation: FileCitation) => setSelectedCitation(citation)}
          />
        ))}

        {isGenerating && (
          <div className="flex items-center gap-3 text-xs text-[#fbcfe8] font-mono p-3 rounded-xl bg-[#1f1f23] w-fit border border-[#48454d]/20 animate-pulse">
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            <span>Retrieving code chunks & analyzing architecture...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Prompt Suggestions */}
      {messages.length <= 2 && (
        <div className="px-5 pb-2">
          <PromptSuggestions
            suggestions={[
              'Where is authentication implemented and how does it work?',
              'Explain how data access and database repositories are structured',
              'What REST endpoints are exposed in this codebase?',
              'Explain the core service business logic',
            ]}
            onSelectSuggestion={(text: string) => handleSendQuery(text)}
          />
        </div>
      )}

      {/* Input Box */}
      <div className="p-4 border-t border-[#48454d]/20 bg-[#1a1b1e]">
        <div className="relative flex items-center">
          <input
            type="text"
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendQuery();
              }
            }}
            placeholder={`Ask a question about ${activeRepo.name} source code...`}
            className="w-full bg-[#121316] border border-[#48454d]/30 focus:border-[#fbcfe8]/60 rounded-xl py-3 pl-4 pr-24 text-xs sm:text-sm text-[#e3e2e6] placeholder:text-[#938f98] outline-none transition-colors"
          />

          <div className="absolute right-2 flex items-center gap-1">
            <Button
              variant="primary"
              size="sm"
              disabled={!inputQuery.trim() || isGenerating}
              onClick={() => handleSendQuery()}
              className="py-1.5 px-3 shadow-md"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Citation File Viewer Modal */}
      <FileViewerModal
        citation={selectedCitation}
        onClose={() => setSelectedCitation(null)}
      />
    </div>
  );
};
