'use client';
import { useCallback, useRef, useState, useEffect } from 'react';
import { DataTable } from '@/components/DataTable';
import { ChartView, type ChartDisplay } from '@/components/ChartView';
import { SaveTemplateModal } from './SaveTemplateModal';
import { FieldAttacher, type AttachedField } from './FieldAttacher';
import { ConversationHistory } from './ConversationHistory';
import { exportConversation, type ExportableConversation, type ExportUser } from './exportConversation';
import { JalaliDatePicker, type JalaliPickerResult } from '@/components/JalaliDatePicker';
import { formatJalaliISO, formatJalaliLong, jalaliRangeBoundaries, jalaliToUtcDate, objectIdBoundary } from '@/lib/jalali';

interface LlmReport {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation: string;
  warnings?: string[];
}
interface Execution { ok: boolean; rows?: Record<string, unknown>[]; took?: number; count?: number; truncated?: boolean; error?: string }
interface RepairAttempt { message: string; report: LlmReport; execution: Execution }
// `needs` is a structured hint from the agent that the current question is a
// date pick: the UI renders an inline Jalali calendar instead of relying on
// the user to type an ISO timestamp. Only set on the most recent assistant
// turn; cleared implicitly when a new turn arrives.
export interface AgenticNeedsDate { type: 'date' | 'dateRange'; label?: string; field?: string }
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  kind?: 'question' | 'report' | 'repair';
  needs?: AgenticNeedsDate;
}
// A snapshot of a generated pipeline persisted on every successful report
// turn. Mirrors the server-side ConversationVersion in
// `api/reports/agentic/route.ts` — keep the two shapes in sync.
export interface ConversationVersion {
  id: string;
  createdAt: string;
  source: 'initial' | 'repair';
  collection: string;
  pipeline: Record<string, unknown>[];
  display: LlmReport['display'];
  explanation: string;
  warnings: string[];
  execution: { ok: boolean; count?: number; took?: number; truncated?: boolean; error?: string };
  verification?: { ok: false; issue: string };
  triggerMessage: string;
  repairCount: number;
}
interface TurnResponse {
  kind: 'question' | 'report';
  message: string;
  report?: LlmReport;
  execution?: Execution | null;
  repairs?: RepairAttempt[];
  needs?: AgenticNeedsDate | null;
  // Freshly persisted snapshot — the client appends it to its local
  // versions list without a follow-up GET. Null on question turns and on
  // ad-hoc (no conversationId) runs.
  savedVersion?: ConversationVersion | null;
}

const EXAMPLES = [
  'Top 10 users by number of orders in the last 30 days',
  'Monthly revenue from payments for the past 6 months as a line chart',
  'How many orders are in each status? Pie chart please.',
];

export function AgenticClient({ user }: { user: ExportUser }) {
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'turn' | 'exec' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<LlmReport | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [attached, setAttached] = useState<AttachedField[]>([]);
  // Conversation persistence: created lazily on the first user turn, then
  // every subsequent change (history or lastReport) is debounced-PATCHed.
  // `historyRefresh` bumps a key the sidebar listens to so its list reorders
  // after a save without us having to push state down.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  // All saved version snapshots for the active conversation, oldest first.
  // Populated from GET /api/agentic/conversations/[id] on load and appended
  // by every successful agentic POST that returns savedVersion.
  const [versions, setVersions] = useState<ConversationVersion[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);
  // Tracks the last persisted payload so the autosave effect can skip
  // identical writes (e.g. when the user merely toggles a UI control).
  const lastSavedRef = useRef<string>('');
  // Last user-authored prompt; used as the template's `sourcePrompt` so we
  // can show analysts what natural-language ask produced this saved report.
  const lastUserPrompt = [...history].reverse().find(m => m.role === 'user')?.content;

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [history, busy]);

  const sendTurn = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setErr(null);
    // If the analyst attached schema fields via the "+ Field" picker,
    // append them as an explicit hint block. The LLM already sees the
    // full schema digest, but having the user signal exactly which
    // fields drive the question dramatically reduces the chance of
    // picking the wrong column when several have similar names.
    const attachedBlock = attached.length > 0
      ? '\n\n[Attached fields]\n' + attached.map(a => `- ${a.collection}.${a.path} (${a.type})`).join('\n')
      : '';
    const userContent = trimmed + attachedBlock;
    const nextHist: ChatMsg[] = [...history, { role: 'user', content: userContent }];
    setHistory(nextHist);
    setInput('');
    setAttached([]);
    setBusy('turn');
    // Create the conversation lazily on the first user turn. We do this
    // before the LLM call so the id exists by the time the autosave effect
    // fires after the assistant response is appended. Failing to create
    // shouldn't block the chat itself — the user can still get a reply,
    // it just won't be persisted.
    let cid = conversationId;
    if (!cid) {
      try {
        const cr = await fetch('/api/agentic/conversations', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ history: nextHist }),
        });
        if (cr.ok) {
          const cj = await cr.json() as { id: string };
          cid = cj.id;
          setConversationId(cj.id);
          setHistoryRefresh(n => n + 1);
        }
      } catch { /* see above — non-fatal */ }
    }
    try {
      // Send only the recent slice of the conversation. The server applies
      // its own window too, but trimming here keeps payloads small and
      // avoids tripping the body validator after long sessions. Drop any
      // empty/whitespace-only entries — older sessions may contain pure-
      // report assistant turns that were stored with content=''.
      const recent = nextHist
        .map(m => ({ role: m.role, content: m.content.trim() }))
        .filter(m => m.content.length > 0)
        .slice(-24)
        .map(m => ({
          role: m.role,
          // Defensive cap: long pasted errors or huge plan blocks could push a
          // single message over the server's per-message limit.
          content: m.content.length > 8000 ? m.content.slice(0, 8000) + '…' : m.content,
        }));
      const r = await fetch('/api/reports/agentic', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          history: recent,
          lastReport: report,
          execute: true,
          // Including the id makes the server append a version snapshot to
          // this conversation’s versions[] after the turn. Unset for the
          // very first user turn before lazy-creation completes.
          conversationId: cid ?? undefined,
        }),
      });
      // Tolerant body decoding: under transient backend faults (uncaught
      // exception in the route handler, proxy 502, auth bounce to login)
      // the response is HTML, not JSON. Parsing it blindly throws the
      // infamous "Unexpected token '<'" and the user is stuck. Read as
      // text first, then try to coerce — keep a short snippet so the
      // surfaced error is debuggable.
      const raw = await r.text();
      let j: TurnResponse & { error?: string; message?: string } = {} as TurnResponse;
      try { j = JSON.parse(raw); }
      catch {
        const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
        setErr(`Server returned a non-JSON response (HTTP ${r.status}). ${snippet ? 'Body: ' + snippet : ''}`.trim());
        setBusy(null);
        return;
      }
      if (!r.ok) { setErr(j.message ?? j.error ?? `request failed (HTTP ${r.status})`); setBusy(null); return; }
      // Build the post-turn chat: the initial assistant turn, then one
      // bubble per auto-repair attempt so the user can follow what the
      // agent did to recover from each execution failure. Always store
      // *some* content so the bubble survives the next-turn validation —
      // a pure-report turn often has an empty `message`, in which case
      // the report's own explanation is the most useful thing to keep.
      const primaryContent = (j.message?.trim()
        || j.report?.explanation?.trim()
        || (j.kind === 'report' ? '(produced a report)' : '(no message)'));
      const appended: ChatMsg[] = [{
        role: 'assistant',
        content: primaryContent,
        kind: j.kind,
        // Only attach `needs` to question turns — reports are terminal.
        ...(j.kind === 'question' && j.needs ? { needs: j.needs } : {}),
      }];
      for (const rep of j.repairs ?? []) {
        const verdict = rep.execution.ok
          ? ` ✓ (${rep.execution.count ?? rep.execution.rows?.length ?? 0} rows)`
          : ` ✗ (${rep.execution.error ?? 'failed'})`;
        const repMsg = (rep.message?.trim() || rep.report?.explanation?.trim() || '(repair attempt)');
        appended.push({ role: 'assistant', content: repMsg + verdict, kind: 'repair' });
      }
      setHistory(h => [...h, ...appended]);
      if (j.kind === 'report' && j.report) {
        setReport(j.report);
        setExecution(j.execution ?? null);
        // Append the server-persisted version snapshot to the local list so
        // the versions panel updates immediately without an extra GET.
        if (j.savedVersion) {
          setVersions(vs => [...vs, j.savedVersion as ConversationVersion]);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally { setBusy(null); }
  }, [history, report, busy, attached, conversationId]);

  // When the agent asked a date question (kind=question + needs={type:date|dateRange})
  // and the user picked a date in the inline Jalali calendar, we format the
  // selection as a richly-structured user message and send it back as the
  // next turn. The message includes BOTH the Jalali form (for the agent's
  // context / its echo back to the user) and the canonical Gregorian ISO
  // plus an ObjectId boundary, so the agent can paste either form directly
  // into the pipeline without any further conversion.
  const submitPickedDate = useCallback((needs: AgenticNeedsDate, result: JalaliPickerResult) => {
    const fieldNote = needs.field ? ` (intended for field: \`${needs.field}\`)` : '';
    let text: string;
    if (result.mode === 'single') {
      const j = result.start;
      const utc = jalaliToUtcDate(j.jy, j.jm, j.jd, 0, 0, 0, 0);
      const iso = utc.toISOString();
      const oid = objectIdBoundary(utc);
      text = [
        `📅 Date answer${fieldNote}:`,
        `- Jalali: ${formatJalaliLong(j)} (${formatJalaliISO(j)})`,
        `- Gregorian (UTC, start of day): ${iso}`,
        `- ObjectId boundary: ${oid}`,
        `Use this in the pipeline as {"$date": "${iso}"} for date fields, or {"$oid": "${oid}"} when filtering on _id.`,
      ].join('\n');
    } else {
      const { startIso, endIso, startOid, endOid } = jalaliRangeBoundaries(result.start, result.end);
      text = [
        `📅 Date-range answer${fieldNote}:`,
        `- Jalali range: ${formatJalaliISO(result.start)} → ${formatJalaliISO(result.end)} (${formatJalaliLong(result.start)} → ${formatJalaliLong(result.end)})`,
        `- Gregorian range (UTC, $gte start / $lt end-exclusive):`,
        `    start = ${startIso}`,
        `    end   = ${endIso}`,
        `- ObjectId range (same semantics): start = ${startOid}, end = ${endOid}`,
        `Suggested filter on a date field: { "$gte": {"$date":"${startIso}"}, "$lt": {"$date":"${endIso}"} }`,
        `Suggested _id fallback:          { "$gte": {"$oid":"${startOid}"},  "$lt": {"$oid":"${endOid}"} }`,
      ].join('\n');
    }
    // Strip `needs` from the assistant turn so the picker closes immediately
    // on submit (otherwise it would briefly re-render before sendTurn updates).
    setHistory(h => h.map((m, i) => i === h.length - 1 && m.role === 'assistant' ? { ...m, needs: undefined } : m));
    void sendTurn(text);
  }, [sendTurn]);

  // Cancel the picker without sending anything: just strip `needs` from the
  // last assistant turn so the inline calendar disappears. The user can then
  // type a free-form reply if they wanted to.
  const dismissPicker = useCallback(() => {
    setHistory(h => h.map((m, i) => i === h.length - 1 && m.role === 'assistant' ? { ...m, needs: undefined } : m));
  }, []);

  // Autosave: whenever the conversation has been created and the history /
  // last report change, PATCH the server after a short debounce. Skips
  // identical payloads (`lastSavedRef`) so re-renders that don't actually
  // change persisted data don't trigger writes.
  useEffect(() => {
    if (!conversationId || history.length === 0) return;
    const payload = JSON.stringify({ history, lastReport: report });
    if (payload === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/agentic/conversations/${conversationId}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: payload,
          });
          if (r.ok) {
            lastSavedRef.current = payload;
            // Nudge the sidebar so updatedAt ordering reflects the save.
            setHistoryRefresh(n => n + 1);
          }
        } catch { /* network blip — next change will retry */ }
      })();
    }, 1200);
    return () => clearTimeout(timer);
  }, [history, report, conversationId]);

  // Load an existing conversation into the local state, replacing whatever
  // is currently in view. `setExecution(null)` because we deliberately don't
  // persist row data — the user re-runs ▶ Execute to refresh it.
  const loadConversation = useCallback(async (id: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/agentic/conversations/${id}`);
      if (!r.ok) { setErr('Failed to load conversation'); return; }
      const j = await r.json() as {
        id: string; history: ChatMsg[]; lastReport: LlmReport | null;
        versions?: ConversationVersion[];
      };
      setConversationId(j.id);
      setHistory(j.history ?? []);
      setReport(j.lastReport ?? null);
      setVersions(j.versions ?? []);
      setExecution(null);
      setInput(''); setAttached([]);
      // Seed lastSavedRef so the autosave effect doesn't immediately rewrite
      // the freshly-loaded payload back to the server.
      lastSavedRef.current = JSON.stringify({ history: j.history ?? [], lastReport: j.lastReport ?? null });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to load');
    }
  }, []);

  const executeReport = useCallback(async () => {
    if (!report || busy) return;
    setBusy('exec'); setErr(null);
    try {
      const r = await fetch('/api/reports/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: report.collection, pipeline: report.pipeline }),
      });
      let j: { rows?: Record<string, unknown>[]; took?: number; count?: number; truncated?: boolean; error?: string; message?: string } = {};
      try { j = await r.json(); } catch { /* non-JSON response */ }
      if (!r.ok) {
        setExecution({ ok: false, error: j.message ?? j.error ?? `HTTP ${r.status}` });
        return;
      }
      setExecution({ ok: true, rows: j.rows ?? [], took: j.took, count: j.count ?? (j.rows?.length ?? 0), truncated: j.truncated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExecution({ ok: false, error: 'request_failed: ' + msg });
      setErr('Execute failed: ' + msg);
    } finally { setBusy(null); }
  }, [report, busy]);

  function resetSession() {
    if (history.length > 0 && !confirm('Start a new conversation? The current one is already saved in History.')) return;
    setHistory([]); setReport(null); setExecution(null); setErr(null); setInput(''); setAttached([]);
    setConversationId(null);
    setVersions([]);
    lastSavedRef.current = '';
  }

  // Load a saved version's snapshot back into the active report pane. The
  // chat history is left intact — only the report state changes — so the
  // analyst can "rewind" to a prior generated pipeline without losing the
  // conversation context. Execution rows are cleared because they belonged
  // to a different run; the user re-clicks ▶ Execute to refresh.
  const restoreVersion = useCallback((v: ConversationVersion) => {
    setReport({
      collection: v.collection,
      pipeline: v.pipeline,
      display: v.display,
      explanation: v.explanation,
      warnings: v.warnings,
    });
    setExecution(null);
    setErr(null);
  }, []);

  // Export the conversation that's currently in view as a .txt file. Uses
  // local state so it works even before the autosave PATCH has finished —
  // the user doesn't have to wait for the round-trip to download a fresh
  // transcript.
  const exportCurrent = useCallback(() => {
    if (history.length === 0) return;
    const conv: ExportableConversation = {
      id: conversationId ?? '(unsaved)',
      title: [...history].find(m => m.role === 'user')?.content?.slice(0, 80) ?? 'Untitled',
      history,
      lastReport: report,
      createdAt: null,
      updatedAt: new Date().toISOString(),
    };
    exportConversation(conv, user);
  }, [history, report, conversationId, user]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tighter2">Agentic Report</h1>
          <p className="text-sm text-muted mt-1">
            Converse with the AI to build, refine and execute reports. Results appear on the left.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ConversationHistory
            currentId={conversationId}
            refreshKey={historyRefresh}
            user={user}
            onLoad={loadConversation}
            onDeleted={(id) => {
              // If the user deleted the conversation they're currently
              // looking at, clear local state so we don't keep PATCHing a
              // tombstone.
              if (id === conversationId) {
                setConversationId(null); setHistory([]); setReport(null);
                setExecution(null); setInput(''); setAttached([]); setVersions([]);
                lastSavedRef.current = '';
              }
            }}
          />
          <button
            className="btn-ghost btn-sm"
            onClick={exportCurrent}
            disabled={history.length === 0}
            title="Export this conversation as a .txt file">
            ⤓ Export
          </button>
          <button className="btn-ghost btn-sm" onClick={resetSession} disabled={history.length === 0 && conversationId === null}>↻ New</button>
        </div>
      </div>

      {err && <div className="card card-pad text-err text-sm whitespace-pre-wrap">{err}</div>}
      {savedNotice && (
        <div className="card card-pad text-sm flex items-center justify-between gap-3">
          <span className="text-ok">✓ {savedNotice}</span>
          <button className="btn-subtle btn-sm" onClick={() => setSavedNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4 items-start">
        <ResultPanel
          report={report} execution={execution} busy={busy}
          onExecute={executeReport}
          onSaveAsTemplate={() => setSavingTemplate(true)}
          canSave={report !== null && (execution?.ok ?? false)}
          versions={versions}
          onRestoreVersion={restoreVersion}
        />
        <ChatPanel
          history={history} input={input} busy={busy} chatRef={chatRef}
          onInput={setInput} onSend={() => sendTurn(input)}
          onExample={(s) => { setInput(s); }}
          showExamples={history.length === 0}
          attached={attached} onAttachedChange={setAttached}
          onPickedDate={submitPickedDate}
          onDismissPicker={dismissPicker}
        />
      </div>

      {savingTemplate && report && (
        <SaveTemplateModal
          report={report}
          sourcePrompt={lastUserPrompt}
          onClose={() => setSavingTemplate(false)}
          onSaved={() => {
            setSavingTemplate(false);
            setSavedNotice('Saved to Saved Reports. Find it in the sidebar to run it again with different parameters.');
          }}
        />
      )}
    </div>
  );
}

function ResultPanel({ report, execution, busy, onExecute, onSaveAsTemplate, canSave, versions, onRestoreVersion }: {
  report: LlmReport | null; execution: Execution | null;
  busy: 'turn' | 'exec' | null; onExecute: () => void;
  onSaveAsTemplate: () => void;
  canSave: boolean;
  versions: ConversationVersion[];
  onRestoreVersion: (v: ConversationVersion) => void;
}) {
  if (!report) {
    return (
      <div className="card card-pad min-h-[460px] min-w-0 grid place-items-center text-center">
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
  const displayKind = report.display?.kind ?? 'table';
  return (
    <div className="space-y-3 min-w-0">
      <div className="card card-pad space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill"><span className="text-muted mr-1">collection</span>
              <span className="font-mono text-ink">{report.collection}</span>
            </span>
            <span className="pill num">display · {displayKind}</span>
            {execution?.ok && execution.took !== undefined && (
              <span className="pill-ok num">{execution.took} ms · {execution.count} rows{execution.truncated ? ' · truncated' : ''}</span>
            )}
            {execution && !execution.ok && <span className="pill-err">execution failed</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="btn-ghost btn-sm"
              disabled={!canSave || busy !== null}
              onClick={onSaveAsTemplate}
              title={canSave ? 'Save this pipeline as a reusable report template' : 'Execute the query successfully before saving'}>
              ☆ Save as template
            </button>
            <button className="btn-primary btn-sm" disabled={busy !== null} onClick={onExecute}>
              {busy === 'exec' ? 'Running…' : '▶ Execute'}
            </button>
          </div>
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
          {displayKind !== 'table' && report.display && (
            <ChartView rows={rows} display={report.display as ChartDisplay} />
          )}
          <DataTable rows={rows} title={report.display.title || report.collection} />
        </div>
      )}
      {execution?.ok && rows && rows.length === 0 && (
        <div className="surface p-4 text-sm text-muted">Query returned no rows.</div>
      )}

      {!execution && (
        <div className="surface p-4 text-sm text-muted">
          Pipeline ready but not executed yet. Click <span className="font-medium text-ink">▶ Execute</span> above to run it.
        </div>
      )}

      <VersionsPanel
        versions={versions}
        activePipeline={report.pipeline}
        onRestore={onRestoreVersion}
      />
    </div>
  );
}

// Browse / restore prior generated pipelines within this conversation.
// Rendered below the active report card. Each row summarises one version
// snapshot (timestamp, source, row count or error, the user message that
// triggered it) and links to a Restore action that swaps the snapshot back
// into the active report pane. The current version is highlighted by
// comparing pipelines structurally.
function VersionsPanel({ versions, activePipeline, onRestore }: {
  versions: ConversationVersion[];
  activePipeline: Record<string, unknown>[];
  onRestore: (v: ConversationVersion) => void;
}) {
  if (versions.length === 0) {
    return null;
  }
  const activeKey = JSON.stringify(activePipeline);
  // Newest first — the most recent refinement is what analysts usually
  // want to inspect.
  const ordered = [...versions].slice().reverse();
  return (
    <div className="card card-pad space-y-2">
      <details>
        <summary className="cursor-pointer text-sm font-medium text-ink-2 flex items-center gap-2">
          <span>Versions</span>
          <span className="pill num text-2xs">{versions.length}</span>
          <span className="text-2xs text-muted font-normal">
            · every generated query is saved automatically
          </span>
        </summary>
        <div className="mt-3 divide-y divide-line/60">
          {ordered.map((v, i) => {
            const isActive = JSON.stringify(v.pipeline) === activeKey;
            const idx = versions.length - i; // human-readable: v1 = oldest
            const when = new Date(v.createdAt);
            const tsLabel = `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            return (
              <div key={v.id}
                className={['py-2 flex items-start gap-3', isActive ? 'bg-accent/5 -mx-2 px-2 rounded' : ''].join(' ')}>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap text-2xs">
                    <span className="pill num">v{idx}</span>
                    {v.source === 'repair' && <span className="pill text-warn">repair · {v.repairCount} attempt{v.repairCount === 1 ? '' : 's'}</span>}
                    {v.execution.ok
                      ? <span className="pill-ok">{v.execution.count ?? 0} rows{v.execution.truncated ? ' · trunc' : ''}{v.execution.took !== undefined ? ` · ${v.execution.took} ms` : ''}</span>
                      : <span className="pill-err">execution failed</span>}
                    {v.verification && !v.verification.ok && <span className="pill text-warn" title={v.verification.issue}>verification flagged</span>}
                    <span className="text-muted">{tsLabel}</span>
                    {isActive && <span className="text-accent-hi">· current</span>}
                  </div>
                  {v.triggerMessage && (
                    <div dir="auto" className="text-xs text-ink-2 truncate" title={v.triggerMessage}>
                      <span className="text-muted">prompt: </span>{v.triggerMessage}
                    </div>
                  )}
                  <div className="text-2xs text-muted truncate" title={v.collection}>
                    <span className="font-mono">{v.collection}</span> · {v.pipeline.length} stage{v.pipeline.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-sm shrink-0"
                  disabled={isActive}
                  onClick={() => onRestore(v)}
                  title={isActive ? 'This version is currently active' : 'Load this pipeline back into the report pane'}>
                  {isActive ? 'Current' : 'Restore'}
                </button>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function ChatPanel({ history, input, busy, chatRef, onInput, onSend, onExample, showExamples, attached, onAttachedChange, onPickedDate, onDismissPicker }: {
  history: ChatMsg[]; input: string; busy: 'turn' | 'exec' | null;
  chatRef: React.RefObject<HTMLDivElement>;
  onInput: (v: string) => void; onSend: () => void;
  onExample: (s: string) => void; showExamples: boolean;
  attached: AttachedField[]; onAttachedChange: (next: AttachedField[]) => void;
  onPickedDate: (needs: AgenticNeedsDate, result: JalaliPickerResult) => void;
  onDismissPicker: () => void;
}) {
  // Render the date picker only inside the MOST RECENT assistant question
  // that still carries a `needs` hint. We compare by index so earlier turns
  // (which are immutable history) don't re-open the calendar.
  const lastIdx = history.length - 1;
  return (
    <div className="card flex flex-col h-[min(720px,calc(100vh-180px))] sticky top-4 min-w-0">
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
        {history.map((m, i) => {
          const showPicker = i === lastIdx && m.role === 'assistant' && !!m.needs;
          return (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div dir="auto" className={[
                'max-w-[88%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed',
                m.role === 'user'
                  ? 'bg-accent/15 text-ink border border-accent-lo/40'
                  : 'bg-panel2/70 text-ink-2 border border-line',
              ].join(' ')}>
                {m.kind === 'report' && <div className="text-2xs text-accent-hi mb-1 uppercase tracking-[0.08em]">report</div>}
                {m.kind === 'question' && <div className="text-2xs text-warn mb-1 uppercase tracking-[0.08em]">clarify</div>}
                {m.kind === 'repair' && <div className="text-2xs text-warn mb-1 uppercase tracking-[0.08em]">auto-repair</div>}
                {m.content}
                {showPicker && m.needs && (
                  <JalaliDatePicker
                    mode={m.needs.type === 'dateRange' ? 'range' : 'single'}
                    label={m.needs.label || (m.needs.type === 'dateRange' ? 'Pick the date range' : 'Pick the date')}
                    fieldHint={m.needs.field}
                    onConfirm={(r) => onPickedDate(m.needs!, r)}
                    onCancel={onDismissPicker}
                  />
                )}
              </div>
            </div>
          );
        })}
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
        {attached.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attached.map((a, i) => (
              <span key={`${a.collection}.${a.path}.${i}`} className="pill-accent gap-1.5">
                <span className="font-mono">{a.collection}.{a.path}</span>
                <span className="text-muted">{a.type}</span>
                <button type="button" className="text-muted hover:text-ink"
                  onClick={() => onAttachedChange(attached.filter((_, j) => j !== i))}
                  aria-label={`Remove ${a.collection}.${a.path}`}>✕</button>
              </span>
            ))}
          </div>
        )}
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
          <div className="flex items-center gap-2">
            <FieldAttacher attached={attached} onChange={onAttachedChange} disabled={busy !== null} />
            <span className="text-2xs text-muted hidden sm:inline">⌘/Ctrl + Enter to send</span>
          </div>
          <button className="btn-primary btn-sm" disabled={!input.trim() || busy !== null} onClick={onSend}>
            {busy === 'turn' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
