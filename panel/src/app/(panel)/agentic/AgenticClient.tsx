'use client';
import { useCallback, useRef, useState, useEffect } from 'react';
import { DataTable } from '@/components/DataTable';
import { ChartView, type ChartDisplay } from '@/components/ChartView';

interface LlmReport {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation: string;
  warnings?: string[];
}
interface Execution { ok: boolean; rows?: Record<string, unknown>[]; took?: number; count?: number; truncated?: boolean; error?: string }
interface ChatMsg { role: 'user' | 'assistant'; content: string; kind?: 'question' | 'report' }
interface TurnResponse { kind: 'question' | 'report'; message: string; report?: LlmReport; execution?: Execution | null }

const EXAMPLES = [
  'Top 10 users by number of orders in the last 30 days',
  'Monthly revenue from payments for the past 6 months as a line chart',
  'How many orders are in each status? Pie chart please.',
];

export function AgenticClient() {
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'turn' | 'exec' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<LlmReport | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [history, busy]);

  const sendTurn = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setErr(null);
    const nextHist: ChatMsg[] = [...history, { role: 'user', content: trimmed }];
    setHistory(nextHist);
    setInput('');
    setBusy('turn');
    try {
      const r = await fetch('/api/reports/agentic', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          history: nextHist.map(m => ({ role: m.role, content: m.content })),
          lastReport: report,
          execute: true,
        }),
      });
      const j = (await r.json()) as TurnResponse & { error?: string; message?: string };
      if (!r.ok) { setErr(j.message ?? j.error ?? 'request failed'); setBusy(null); return; }
      setHistory(h => [...h, { role: 'assistant', content: j.message, kind: j.kind }]);
      if (j.kind === 'report' && j.report) {
        setReport(j.report);
        setExecution(j.execution ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally { setBusy(null); }
  }, [history, report, busy]);

  const executeReport = useCallback(async () => {
    if (!report || busy) return;
    setBusy('exec'); setErr(null);
    try {
      const r = await fetch('/api/reports/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: report.collection, pipeline: report.pipeline }),
      });
      const j = await r.json();
      if (!r.ok) { setExecution({ ok: false, error: j.message ?? j.error ?? 'execution failed' }); return; }
      setExecution({ ok: true, rows: j.rows, took: j.took, count: j.count, truncated: j.truncated });
    } finally { setBusy(null); }
  }, [report, busy]);

  function resetSession() {
    if (!confirm('Start a new conversation? Current report and chat will be cleared.')) return;
    setHistory([]); setReport(null); setExecution(null); setErr(null); setInput('');
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tighter2">Agentic Report</h1>
          <p className="text-sm text-muted mt-1">
            Converse with the AI to build, refine and execute reports. Results appear on the left.
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={resetSession} disabled={history.length === 0}>↻ New session</button>
      </div>

      {err && <div className="card card-pad text-err text-sm whitespace-pre-wrap">{err}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4 items-start">
        <ResultPanel report={report} execution={execution} busy={busy} onExecute={executeReport} />
        <ChatPanel
          history={history} input={input} busy={busy} chatRef={chatRef}
          onInput={setInput} onSend={() => sendTurn(input)}
          onExample={(s) => { setInput(s); }}
          showExamples={history.length === 0}
        />
      </div>
    </div>
  );
}

function ResultPanel({ report, execution, busy, onExecute }: {
  report: LlmReport | null; execution: Execution | null;
  busy: 'turn' | 'exec' | null; onExecute: () => void;
}) {
  if (!report) {
    return (
      <div className="card card-pad min-h-[460px] grid place-items-center text-center">
        <div className="space-y-2 max-w-sm">
          <div className="text-muted text-sm">No report yet.</div>
          <div className="text-xs text-muted">
            Ask a question on the right. The AI may ask clarifying questions before
            producing a pipeline. Once it does, results appear here and refresh as
            you refine.
          </div>
        </div>
      </div>
    );
  }
  const rows = execution?.rows;
  return (
    <div className="space-y-3">
      <div className="card card-pad space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill"><span className="text-muted mr-1">collection</span>
              <span className="font-mono text-ink">{report.collection}</span>
            </span>
            <span className="pill num">display · {report.display.kind}</span>
            {execution?.ok && execution.took !== undefined && (
              <span className="pill-ok num">{execution.took} ms · {execution.count} rows{execution.truncated ? ' · truncated' : ''}</span>
            )}
            {execution && !execution.ok && <span className="pill-err">execution failed</span>}
          </div>
          <button className="btn-primary btn-sm" disabled={busy !== null} onClick={onExecute}>
            {busy === 'exec' ? 'Running…' : '▶ Execute'}
          </button>
        </div>
        <p dir="auto" className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{report.explanation}</p>
        {report.warnings && report.warnings.length > 0 && (
          <div className="text-warn text-xs space-y-1">
            {report.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted hover:text-ink-2">View pipeline JSON</summary>
          <pre className="text-2xs bg-bg/60 p-3 rounded-md mt-2 overflow-x-auto font-mono text-ink-2">
{JSON.stringify(report.pipeline, null, 2)}
          </pre>
        </details>
      </div>

      {execution && !execution.ok && execution.error && (
        <div className="card card-pad border-err/40">
          <div className="label mb-1 text-err">MongoDB error</div>
          <pre className="text-xs text-err whitespace-pre-wrap font-mono">{execution.error}</pre>
        </div>
      )}

      {execution?.ok && rows && rows.length > 0 && (
        <div className="space-y-3">
          {report.display.kind !== 'table' && (
            <ChartView rows={rows} display={report.display as ChartDisplay} />
          )}
          <DataTable rows={rows} />
        </div>
      )}
      {execution?.ok && rows && rows.length === 0 && (
        <div className="surface p-4 text-sm text-muted">Query returned no rows.</div>
      )}
    </div>
  );
}

function ChatPanel({ history, input, busy, chatRef, onInput, onSend, onExample, showExamples }: {
  history: ChatMsg[]; input: string; busy: 'turn' | 'exec' | null;
  chatRef: React.RefObject<HTMLDivElement>;
  onInput: (v: string) => void; onSend: () => void;
  onExample: (s: string) => void; showExamples: boolean;
}) {
  return (
    <div className="card flex flex-col h-[min(720px,calc(100vh-180px))] sticky top-4">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div className="text-sm font-medium tracking-tightish">Conversation</div>
        <span className="text-2xs text-muted">{history.length} message{history.length === 1 ? '' : 's'}</span>
      </div>
      <div ref={chatRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {history.length === 0 && (
          <div className="text-xs text-muted">
            Ask in any language. The agent will request clarification when needed,
            otherwise produce and run a read-only MongoDB pipeline.
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div dir="auto" className={[
              'max-w-[88%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed',
              m.role === 'user'
                ? 'bg-accent/15 text-ink border border-accent-lo/40'
                : 'bg-panel2/70 text-ink-2 border border-line',
            ].join(' ')}>
              {m.kind === 'report' && <div className="text-2xs text-accent-hi mb-1 uppercase tracking-[0.08em]">report</div>}
              {m.kind === 'question' && <div className="text-2xs text-warn mb-1 uppercase tracking-[0.08em]">clarify</div>}
              {m.content}
            </div>
          </div>
        ))}
        {busy === 'turn' && (
          <div className="flex justify-start">
            <div className="bg-panel2/70 text-muted border border-line rounded-lg px-3 py-2 text-sm">
              <span className="inline-block animate-pulse">Thinking…</span>
            </div>
          </div>
        )}
        {showExamples && (
          <div className="pt-1">
            <div className="label mb-1">Try</div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map(s => (
                <button key={s} className="pill hover:bg-panel" onClick={() => onExample(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-line p-3 space-y-2">
        <textarea
          className="input min-h-[64px] text-[14px]"
          dir="auto"
          placeholder="Ask, refine, or answer the agent…"
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-muted">⌘/Ctrl + Enter to send</span>
          <button className="btn-primary btn-sm" disabled={!input.trim() || busy !== null} onClick={onSend}>
            {busy === 'turn' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
