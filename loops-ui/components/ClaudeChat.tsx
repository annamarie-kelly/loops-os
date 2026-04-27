'use client';

// ClaudeChat — slide-out chat panel that sends prompts to Claude Code CLI.
// Action buttons (Decompose, Triage, Review, etc.) pre-fill prompts with
// relevant context so the user doesn't need to type in the terminal.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Loop, SpecDoc } from '@/lib/types';
import { config } from '@/lib/config';

// ─── Types ───────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  isThinking: boolean;
  activity: string | null; // current tool activity (e.g. "Read: spec.md")
  timestamp: number;
}

interface QuickAction {
  label: string;
  icon: string;
  description: string;
  buildPrompt: () => string;
}

// ─── SSE streaming helper ────────────────────────────────────────

interface StreamEvent {
  type: 'thinking' | 'text' | 'session' | 'activity' | 'error';
  text: string;
}

async function streamClaude(
  prompt: string,
  onEvent: (event: StreamEvent) => void,
  opts?: { sessionId?: string; isResume?: boolean; signal?: AbortSignal; cwd?: string },
): Promise<void> {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      sessionId: opts?.sessionId,
      isResume: opts?.isResume,
      cwd: opts?.cwd,
    }),
    signal: opts?.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Claude API error: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') return;
      try {
        const event = JSON.parse(payload) as StreamEvent;
        onEvent(event);
      } catch {
        // skip malformed chunks
      }
    }
  }
}

// ─── Quick actions builder ───────────────────────────────────────

function buildQuickActions(
  loops: Loop[],
  focusedLoop: Loop | null,
  specs: SpecDoc[],
): QuickAction[] {
  const actions: QuickAction[] = [];

  // Triage — when there are untriaged loops
  const triageLoops = loops.filter((l) => !l.done && l.status === 'triage');
  if (triageLoops.length > 0) {
    actions.push({
      label: 'Triage',
      icon: '/triage',
      description: `${triageLoops.length} item${triageLoops.length !== 1 ? 's' : ''} in inbox`,
      buildPrompt: () => '/triage',
    });
  }

  // Review — weekly review
  actions.push({
    label: 'Review',
    icon: '/review',
    description: 'Weekly metacognition',
    buildPrompt: () => '/review',
  });

  // Distill — extract patterns from focused loop
  if (focusedLoop) {
    actions.push({
      label: 'Distill',
      icon: '/distill',
      description: `Extract patterns from "${focusedLoop.text.slice(0, 40)}..."`,
      buildPrompt: () => `/distill ${focusedLoop.source.file}`,
    });
  }

  // Find connections
  actions.push({
    label: 'Connections',
    icon: '/find-connections',
    description: 'Discover links between notes',
    buildPrompt: () => '/find-connections',
  });

  // Today — daily focus
  actions.push({
    label: 'Today',
    icon: '/today',
    description: 'Daily focus snapshot',
    buildPrompt: () => '/today',
  });

  return actions;
}

// ─── Markdown-ish renderer (minimal) ─────────────────────────────

function renderResponseText(text: string): string {
  // Extract markdown tables first, before escaping HTML
  const tableRegex = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;
  const tables = new Map<string, string>();
  let tableIdx = 0;
  const textWithPlaceholders = text.replace(tableRegex, (_match, headerRow, _sepRow, bodyRows) => {
    const placeholder = `%%TABLE_${tableIdx++}%%`;
    const headers = headerRow.split('|').slice(1, -1).map((h: string) => h.trim());
    const rows = bodyRows.trim().split('\n').map((row: string) =>
      row.split('|').slice(1, -1).map((cell: string) => cell.trim())
    );
    const thCells = headers.map((h: string) =>
      `<th class="px-2 py-1 text-left font-medium text-ink border-b border-edge">${h}</th>`
    ).join('');
    const bodyHtml = rows.map((cells: string[]) =>
      `<tr>${cells.map((c: string) =>
        `<td class="px-2 py-1 border-b border-edge/50">${c}</td>`
      ).join('')}</tr>`
    ).join('');
    tables.set(placeholder, `<table class="w-full text-[10px] border-collapse my-2"><thead><tr>${thCells}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
    return placeholder;
  });

  let out = textWithPlaceholders
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Bold
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-ink">$1</strong>');
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code class="font-mono text-[0.92em] px-1 py-[1px] rounded bg-inset">$1</code>');
  // Headers
  out = out.replace(/^### (.+)$/gm, '<h3 class="text-[12px] font-semibold text-ink mt-3 mb-1">$1</h3>');
  out = out.replace(/^## (.+)$/gm, '<h2 class="text-[13px] font-semibold text-ink mt-4 mb-1.5">$1</h2>');
  // Numbered list items
  out = out.replace(/^(\d+)\. (.+)$/gm, '<div class="flex gap-1.5 ml-2"><span class="text-ink-ghost shrink-0">$1.</span><span>$2</span></div>');
  // Bullet list items
  out = out.replace(/^- (.+)$/gm, '<div class="flex gap-1.5 ml-2"><span class="text-ink-ghost shrink-0">-</span><span>$1</span></div>');
  // Paragraphs (double newline)
  out = out.replace(/\n\n/g, '</p><p class="mt-1.5">');
  // Single newlines → line breaks (for sentences that stream without double-newlines)
  out = out.replace(/\n/g, '<br/>');

  // Restore tables
  for (const [placeholder, html] of tables) {
    out = out.replace(placeholder, html);
  }

  return `<p>${out}</p>`;
}

// ─── Component ───────────────────────────────────────────────────

export function ClaudeChat({
  open,
  onClose,
  loops,
  allLoops,
  focusedLoop,
  specs,
  pageContext,
}: {
  open: boolean;
  onClose: () => void;
  loops: Loop[];
  allLoops: Loop[];
  focusedLoop: Loop | null;
  specs: SpecDoc[];
  pageContext?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [showActions, setShowActions] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Where to run `claude -p`. null = vault root (default). The picker
  // below switches it to a configured repo for code-editing chats.
  const [chatCwd, setChatCwd] = useState<string | null>(null);
  const repos = config.repos ?? [];
  const messageCountRef = useRef(0); // tracks messages sent in this session
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queuedPromptRef = useRef<string | null>(null);

  // ── Persist chat state to localStorage ──
  const LS_CHAT = 'loops-ui:chat-state';

  // Restore on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_CHAT);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.sessionId) setSessionId(saved.sessionId);
        if (Array.isArray(saved.messages) && saved.messages.length > 0) {
          // Clean up interrupted streams: remove empty assistant messages,
          // clear isThinking/activity flags from stale state
          const cleaned = (saved.messages as Message[])
            .filter((m) => m.role === 'user' || m.text || m.thinking)
            .map((m) => m.role === 'assistant' ? { ...m, isThinking: false, activity: null } : m);
          setMessages(cleaned);
          if (cleaned.length > 0) setShowActions(false);
          messageCountRef.current = cleaned.filter((m) => m.role === 'user').length;
        }
      }
    } catch {}
  }, []);

  // Save on change
  useEffect(() => {
    try {
      localStorage.setItem(LS_CHAT, JSON.stringify({
        sessionId,
        messages: messages.map((m) => ({
          id: m.id, role: m.role, text: m.text,
          thinking: m.thinking, timestamp: m.timestamp,
        })),
      }));
    } catch {}
  }, [messages, sessionId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !streaming) { e.stopImmediatePropagation(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, streaming, onClose]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!prompt.trim()) return;
      if (streaming) {
        // Queue it — will be sent when current stream finishes
        queuedPromptRef.current = prompt.trim();
        return;
      }

      const userMsg: Message = {
        id: Math.random().toString(36).slice(2),
        role: 'user',
        text: prompt.trim(),
        thinking: '',
        isThinking: false,
        activity: null,
        timestamp: Date.now(),
      };

      const assistantMsg: Message = {
        id: Math.random().toString(36).slice(2),
        role: 'assistant',
        text: '',
        thinking: '',
        isThinking: true,
        activity: null,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput('');
      setStreaming(true);
      setShowActions(false);

      const controller = new AbortController();
      abortRef.current = controller;

      // Generate session ID on first message, resume on subsequent ones
      const isFirst = messageCountRef.current === 0;
      let currentSessionId = sessionId;
      if (!currentSessionId) {
        currentSessionId = crypto.randomUUID();
        setSessionId(currentSessionId);
      }
      messageCountRef.current += 1;

      // On first message in a session, prepend page context so Claude
      // knows what the user is looking at right now.
      let fullPrompt = prompt.trim();
      if (isFirst && pageContext) {
        fullPrompt = `[Page context — the user is currently viewing this in the Loops UI:\n${pageContext}]\n\n${fullPrompt}`;
      }

      try {
        await streamClaude(
          fullPrompt,
          (event) => {
            // Capture session ID from the result event
            if (event.type === 'session') {
              setSessionId(event.text);
              return;
            }

            // Session error — reset session, remove error message, and retry
            if (event.type === 'error' && event.text === 'session_invalid') {
              setSessionId(null);
              messageCountRef.current = 0;
              // Remove the failed assistant message
              setMessages((prev) => prev.filter((m) => m.id !== assistantMsg.id));
              // Retry after a tick with a fresh session
              setTimeout(() => sendPrompt(prompt.trim()), 100);
              return;
            }

            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role !== 'assistant') return prev;

              if (event.type === 'thinking') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, thinking: last.thinking + event.text, isThinking: true, activity: null },
                ];
              } else if (event.type === 'activity') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, activity: event.text, isThinking: false },
                ];
              } else {
                // Text delta = done thinking, clear activity
                return [
                  ...prev.slice(0, -1),
                  { ...last, text: last.text + event.text, isThinking: false, activity: null },
                ];
              }
            });
          },
          {
            sessionId: currentSessionId,
            isResume: !isFirst,
            signal: controller.signal,
            cwd: chatCwd ?? undefined,
          },
        );
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role !== 'assistant') return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, text: last.text + `\n\n[Error: ${(err as Error).message}]`, isThinking: false },
            ];
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // Send queued follow-up if one was typed while streaming
        const queued = queuedPromptRef.current;
        if (queued) {
          queuedPromptRef.current = null;
          setTimeout(() => sendPrompt(queued), 100);
        }
      }
    },
    [streaming, sessionId, chatCwd],
  );

  // Listen for programmatic send events (from action buttons elsewhere in the app)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.prompt && typeof detail.prompt === 'string') {
        sendPrompt(detail.prompt);
      }
    };
    window.addEventListener('claude-chat:send', handler);
    return () => window.removeEventListener('claude-chat:send', handler);
  }, [sendPrompt]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      sendPrompt(input);
    },
    [input, sendPrompt],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt(input);
      }
    },
    [input, sendPrompt],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const quickActions = buildQuickActions(allLoops, focusedLoop, specs);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-[440px] z-50 flex flex-col border-l border-edge shadow-lg" style={{ backgroundColor: 'var(--surface-page)' }}>
      {/* Header — explicit h-[47px] matches the main Header
           (py-2.5 + 26px logo + 1px border) so the bottom borders
           line up exactly where the panel meets the main view. */}
      <div className="px-5 h-[47px] flex items-center gap-3 border-b border-edge shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-[26px] h-[26px] rounded-md bg-mauve-fill flex items-center justify-center shrink-0">
            <span className="text-[11px] text-[var(--mauve)] font-medium">C</span>
          </div>
          {/* Repo picker — vault by default; switches to a configured
              repo so `claude -p` runs against the right tree. Only
              renders when the user has configured at least one repo. */}
          {repos.length > 0 && (
            <select
              value={chatCwd ?? ''}
              onChange={(e) => setChatCwd(e.target.value || null)}
              disabled={streaming}
              className="text-[10px] text-ink-soft bg-transparent border border-edge rounded px-1.5 py-0.5 focus:outline-none focus:border-edge-hover hover:border-edge-hover disabled:opacity-50"
              title="Working directory for `claude -p`"
            >
              <option value="">Vault</option>
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          {sessionId && !streaming && (
            <span className="text-[9px] text-sage-text bg-sage-fill px-1.5 py-0.5 rounded-full">
              session
            </span>
          )}
          {streaming && (
            <span className="text-[10px] text-ink-ghost animate-pulse">streaming...</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setMessages([]);
            setShowActions(true);
            setSessionId(null);
            messageCountRef.current = 0;
            try { localStorage.removeItem(LS_CHAT); } catch {}
          }}
          className="text-[10px] text-ink-ghost hover:text-ink px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
          title="Clear chat"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-ink-ghost hover:text-ink text-[14px] px-1.5 py-0.5 rounded hover:bg-inset transition-colors"
          title="Close"
        >
          &#x2715;
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3 scrollbar-subtle"
      >
        {messages.length === 0 && showActions && (
          <div className="space-y-4">
            <p className="text-[11px] text-ink-ghost leading-relaxed">
              Chat with Claude Code or use a quick action below.
              Actions inject relevant context automatically.
            </p>

            {/* Quick action buttons */}
            <div className="space-y-1.5">
              <div className="text-[10px] text-ink-ghost uppercase tracking-wider font-medium mb-2">
                Quick Actions
              </div>
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => sendPrompt(action.buildPrompt())}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-edge hover:border-edge-hover hover:bg-inset/40 transition-colors group"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] text-[var(--mauve)] font-mono bg-mauve-fill px-1.5 py-0.5 rounded shrink-0">
                      {action.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-ink group-hover:text-ink">
                        {action.label}
                      </div>
                      <div className="text-[10px] text-ink-ghost leading-snug mt-0.5">
                        {action.description}
                      </div>
                    </div>
                    <span className="text-[10px] text-ink-ghost group-hover:text-ink-soft transition-colors">
                      &#x2192;
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`${
              msg.role === 'user'
                ? 'ml-8'
                : 'mr-4'
            }`}
          >
            {msg.role === 'user' ? (
              <div className="bg-mauve-fill rounded-lg px-3 py-2">
                <pre className="text-[11px] text-ink whitespace-pre-wrap break-words font-[inherit] leading-relaxed">
                  {msg.text}
                </pre>
              </div>
            ) : (
              <div className="space-y-0">
                {/* Collapsed thinking content (expandable) */}
                {!msg.isThinking && msg.thinking && (
                  <details className="mb-2 group">
                    <summary className="text-[10px] text-ink-ghost cursor-pointer hover:text-ink-soft transition-colors select-none">
                      <span className="ml-1">Thinking</span>
                      <span className="text-[9px] ml-1 opacity-60">
                        ({Math.round(msg.thinking.length / 4)} tokens)
                      </span>
                    </summary>
                    <div className="mt-1.5 pl-3 border-l-2 border-edge-subtle text-[10px] text-ink-ghost leading-relaxed max-h-[200px] overflow-y-auto scrollbar-subtle">
                      <pre className="whitespace-pre-wrap break-words font-[inherit]">
                        {msg.thinking}
                      </pre>
                    </div>
                  </details>
                )}

                {/* Response text */}
                {msg.text && (
                  <div
                    className="text-[11px] text-ink-soft leading-relaxed [&_p]:my-0 [&_h2]:first:mt-0 [&_h3]:first:mt-0"
                    dangerouslySetInnerHTML={{
                      __html: renderResponseText(msg.text),
                    }}
                  />
                )}
{/* cursor removed */}

                {/* Activity indicator — bottom status bar showing what Claude is doing */}
                {(msg.isThinking || msg.activity) && streaming && messages[messages.length - 1]?.id === msg.id && (
                  <div className="flex items-center gap-2 py-2 mt-2 border-t border-edge-subtle">
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--mauve)] opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--mauve)]" />
                    </span>
                    <span className="text-[10px] text-[var(--mauve)] italic truncate">
                      {msg.activity
                        ? msg.activity.startsWith('Read') ? `Reading ${msg.activity.slice(6).split('/').pop()}` :
                          msg.activity.startsWith('Glob') ? 'Searching files...' :
                          msg.activity.startsWith('Grep') ? 'Searching code...' :
                          msg.activity.startsWith('Edit') ? `Editing ${msg.activity.slice(6).split('/').pop()}` :
                          msg.activity.startsWith('Write') ? `Writing ${msg.activity.slice(7).split('/').pop()}` :
                          msg.activity.startsWith('Bash') ? 'Running command...' :
                          msg.activity.startsWith('Skill') ? `Running ${msg.activity.slice(7)}` :
                          msg.activity
                        : 'Thinking...'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input area — always visible, queues follow-ups while streaming */}
      <div className="shrink-0 border-t border-edge px-4 py-3">
        <form onSubmit={handleSubmit} className="flex items-end gap-0 bg-inset rounded-xl border border-edge focus-within:border-[var(--mauve)] transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={streaming ? 'Type a follow-up (queued until done)...' : 'Type a message...'}
            rows={1}
            className="flex-1 min-h-[40px] max-h-[120px] px-3.5 py-2.5 text-[12px] text-ink bg-transparent focus:outline-none placeholder:text-ink-ghost leading-snug"
            style={{
              height: 'auto',
              resize: 'none',
              overflowY: input.split('\n').length > 4 ? 'auto' : 'hidden',
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
            }}
          />
          <div className="flex items-center gap-1.5 pr-2 pb-1.5 shrink-0">
            {streaming && (
              <button
                type="button"
                onClick={stopStreaming}
                className="w-[28px] h-[28px] rounded-full bg-rose-fill/20 flex items-center justify-center hover:bg-rose-fill/40 transition-colors"
                title="Stop"
                aria-label="Stop"
              >
                <svg width={10} height={10} viewBox="0 0 16 16" fill="currentColor" className="text-rose-text">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                </svg>
              </button>
            )}
            <button
              type="submit"
              disabled={!input.trim()}
              className="w-[28px] h-[28px] rounded-full flex items-center justify-center text-ink-soft hover:text-ink transition-colors disabled:opacity-20"
              title={streaming && input.trim() ? 'Queue' : 'Send'}
              aria-label={streaming && input.trim() ? 'Queue' : 'Send'}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </div>
        </form>
        {queuedPromptRef.current && streaming && (
          <div className="mt-1.5 text-[10px] text-tan-text italic">
            Follow-up queued — will send when done
          </div>
        )}

        {/* Action chips when chat has messages */}
        {!streaming && messages.length > 0 && (
          <div className="flex gap-1.5 mt-2 flex-wrap">
            {quickActions.slice(0, 4).map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => sendPrompt(action.buildPrompt())}
                className="text-[9px] text-ink-ghost hover:text-ink bg-inset hover:bg-inset/80 px-2 py-1 rounded-md transition-colors"
              >
                {action.icon}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
