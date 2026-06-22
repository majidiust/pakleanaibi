'use client';
import { useEffect, useRef, useState } from 'react';

type RelType = 'one-to-one'|'one-to-many'|'many-to-one'|'many-to-many'|'embedded'|'soft'|'derived'|'chain';
interface Suggestion {
  source: { collection: string; field: string };
  target: { collection: string; field: string; matchOn?: string };
  type: RelType;
  cardinality?: '1:1'|'1:N'|'N:1'|'N:N';
  confidence: number;
  reason: string;
  signals?: string[];
}
type ChatMsg =
  | { role: 'assistant'; content: string; suggestions: Suggestion[] }
  | { role: 'user'; content: string };

function sugKey(s: Suggestion): string {
  return `${s.source.collection}.${s.source.field}->${s.target.collection}.${s.target.field}|${s.type}`;
}

export function RelationshipAssistant({
  name, initialDescription, canEdit, onRelationshipApproved,
}: {
  name: string;
  initialDescription: string;
  canEdit: boolean;
  onRelationshipApproved?: () => void;
}) {
  const [description, setDescription] = useState(initialDescription);
  const [started, setStarted] = useState(false);
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected' | 'saving'>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [history, loading]);

  async function send(extraUser?: string) {
    setError(null);
    const newHistory: ChatMsg[] = extraUser
      ? [...history, { role: 'user', content: extraUser }]
      : history;
    if (extraUser) setHistory(newHistory);
    setLoading(true);
    try {
      const r = await fetch(`/api/intel/collections/${encodeURIComponent(name)}/converse`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: !started ? description : undefined,
          history: newHistory.map(m => ({
            role: m.role,
            content: m.role === 'user' ? m.content : `${m.content}${m.suggestions.length ? '\n[suggested ' + m.suggestions.length + ']' : ''}`,
          })),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { error?: string; detail?: string } | null;
        const msg = j?.error
          ? (j.detail ? `${j.error}: ${j.detail}` : j.error)
          : `HTTP ${r.status}`;
        setError(msg);
        return;
      }
      const j = await r.json() as { message?: string; suggestions?: Suggestion[]; done?: boolean };
      const content = (j.message ?? '').trim();
      const suggestions = j.suggestions ?? [];
      // Guarantee the bubble is visible even when the model returns an empty
      // message with no suggestions — otherwise the user sees no response and
      // assumes the send did nothing.
      const fallback = suggestions.length
        ? '(no message — see suggestions below)'
        : (j.done ? '(conversation finished)' : '(no response — try rephrasing your answer)');
      setHistory(h => [...h, {
        role: 'assistant',
        content: content || fallback,
        suggestions,
      }]);
      setDone(!!j.done);
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setLoading(false);
    }
  }

  async function approve(s: Suggestion) {
    const key = sugKey(s);
    setDecisions(d => ({ ...d, [key]: 'saving' }));
    try {
      const r = await fetch(`/api/intel/collections/${encodeURIComponent(name)}/suggestions/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(s),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      setDecisions(d => ({ ...d, [key]: 'approved' }));
      onRelationshipApproved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'approve failed');
      setDecisions(d => {
        const rest = { ...d };
        delete rest[key];
        return rest;
      });
    }
  }

  function reject(s: Suggestion) {
    setDecisions(d => ({ ...d, [sugKey(s)]: 'rejected' }));
  }

  function reset() {
    setHistory([]); setStarted(false); setDone(false); setDecisions({}); setError(null);
  }

  return (
    <div className="card card-pad space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="font-semibold tracking-tightish">AI relationship discovery</div>
          <div className="text-xs text-muted mt-0.5">
            Describe the collection in your own words. The assistant will propose relationships,
            ask you about ambiguous fields, and save the ones you approve.
          </div>
        </div>
        {started && (
          <button className="btn-ghost btn-sm" onClick={reset} disabled={loading}>Start over</button>
        )}
      </div>

      {!started && (
        <div className="space-y-2">
          <div className="label">Description (any language)</div>
          <textarea
            dir="auto"
            className="input min-h-[110px] font-sans"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. این کالکشن کاربران فروشگاه است. هر کاربر یک شناسه دارد و سفارش‌ها به آن لینک هستند…"
            disabled={!canEdit}
          />
          <div className="flex justify-end gap-2">
            <button className="btn-primary btn-sm" onClick={() => send()}
              disabled={loading || !canEdit || !description.trim()}>
              {loading ? 'Thinking…' : '✨ Discover relationships'}
            </button>
          </div>
        </div>
      )}

      {started && (
        <>
          <div ref={scrollRef} className="space-y-3 max-h-[480px] overflow-y-auto pr-1 -mr-1">
            {history.map((m, i) => m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div dir="auto" className="max-w-[85%] rounded-lg bg-accent/15 border border-accent/30 px-3 py-2 text-sm text-ink whitespace-pre-wrap">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="space-y-2">
                <div className="flex items-start gap-2">
                  <div className="size-6 rounded-md bg-panel2 border border-line text-2xs text-muted flex items-center justify-center font-mono shrink-0">AI</div>
                  <div dir="auto" className="text-sm text-ink-2 whitespace-pre-wrap">{m.content}</div>
                </div>
                {m.suggestions.length > 0 && (
                  <div className="ml-8 grid gap-2">
                    {m.suggestions.map(s => {
                      const key = sugKey(s);
                      const st = decisions[key];
                      return (
                        <div key={key} className="rounded-lg border border-line bg-panel2/40 p-2.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="font-mono text-xs">
                              <span className="text-ink">{s.source.field}</span>
                              <span className="mx-1 text-muted-2">→</span>
                              <span className="text-accent-hi">{s.target.collection}</span>
                              <span className="text-muted">.{s.target.field}</span>
                              {s.target.matchOn && <span className="text-muted-2"> (on {s.target.matchOn})</span>}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="pill">{s.type}</span>
                              {s.cardinality && <span className="pill">{s.cardinality}</span>}
                              <span className={`pill ${s.confidence >= 70 ? 'pill-ok' : s.confidence >= 40 ? 'pill-warn' : 'pill-err'}`}>{s.confidence | 0}%</span>
                            </div>
                          </div>
                          <div dir="auto" className="text-xs text-muted mt-1">{s.reason}</div>
                          {s.signals && s.signals.length > 0 && (
                            <div className="text-2xs text-muted-2 mt-1 flex flex-wrap gap-1">
                              {s.signals.slice(0, 6).map((g, k) => <span key={k} className="pill">{g}</span>)}
                            </div>
                          )}
                          <div className="mt-2 flex items-center justify-end gap-2">
                            {st === 'approved' && <span className="pill pill-ok">✓ Saved</span>}
                            {st === 'rejected' && <span className="pill">Dismissed</span>}
                            {!st && canEdit && (
                              <>
                                <button className="btn-ghost btn-sm" onClick={() => reject(s)}>Reject</button>
                                <button className="btn-primary btn-sm" onClick={() => approve(s)}>Approve</button>
                              </>
                            )}
                            {st === 'saving' && <span className="text-xs text-muted">Saving…</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex items-center gap-2 text-xs text-muted">
                <div className="size-6 rounded-md bg-panel2 border border-line text-2xs flex items-center justify-center font-mono shrink-0">AI</div>
                <span className="inline-flex gap-1">
                  <span className="size-1.5 bg-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="size-1.5 bg-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="size-1.5 bg-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
              </div>
            )}
          </div>

          {error && <div className="text-sm text-err">{error}</div>}

          {done ? (
            <div className="text-xs text-muted-2 italic">Conversation finished. Start over to discover more.</div>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                dir="auto"
                className="input min-h-[60px] font-sans flex-1"
                placeholder="Type your answer or follow-up… (Enter to send, Shift+Enter for newline)"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  // Plain Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter
                  // is kept as an alias so existing muscle memory still works.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing
                      && draft.trim() && !loading) {
                    e.preventDefault();
                    const text = draft.trim();
                    setDraft('');
                    void send(text);
                  }
                }}
                disabled={loading || !canEdit}
              />
              <button
                className="btn-primary btn-sm"
                disabled={loading || !canEdit || !draft.trim()}
                onClick={() => {
                  const text = draft.trim();
                  setDraft('');
                  void send(text);
                }}
              >
                Send
              </button>
            </div>
          )}
        </>
      )}

    </div>
  );
}
