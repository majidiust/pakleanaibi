'use client';
import { useMemo, useState } from 'react';
import {
  JALALI_MONTHS_FA, JALALI_WEEKDAYS_FA, daysInJalaliMonth, formatJalaliISO,
  formatJalaliLong, jalaliDow, todayJalali, toPersianDigits, type JDate,
} from '@/lib/jalali';

export type JalaliPickerMode = 'single' | 'range';
export type JalaliPickerResult =
  | { mode: 'single'; start: JDate; end: null }
  | { mode: 'range'; start: JDate; end: JDate };

interface Props {
  mode?: JalaliPickerMode;
  label?: string;                       // e.g. "Pick the cutoff date"
  fieldHint?: string;                   // e.g. "dCreateDate" — included in the readout for the agent
  onConfirm: (r: JalaliPickerResult) => void;
  onCancel: () => void;
}

const sameDay = (a: JDate, b: JDate) => a.jy === b.jy && a.jm === b.jm && a.jd === b.jd;
const cmpDay = (a: JDate, b: JDate) => (a.jy - b.jy) || (a.jm - b.jm) || (a.jd - b.jd);

export function JalaliDatePicker({ mode = 'single', label, fieldHint, onConfirm, onCancel }: Props) {
  const today = useMemo(() => todayJalali(), []);
  const [view, setView] = useState<{ jy: number; jm: number }>({ jy: today.jy, jm: today.jm });
  const [start, setStart] = useState<JDate | null>(mode === 'single' ? today : null);
  const [end, setEnd] = useState<JDate | null>(null);

  const gridDays = useMemo(() => {
    const first: JDate = { jy: view.jy, jm: view.jm, jd: 1 };
    const lead = jalaliDow(first);
    const total = daysInJalaliMonth(view.jy, view.jm);
    const cells: (JDate | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= total; d++) cells.push({ jy: view.jy, jm: view.jm, jd: d });
    while (cells.length % 7 !== 0) cells.push(null);
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [view]);

  const inRange = (d: JDate): boolean => {
    if (mode !== 'range' || !start || !end) return false;
    return cmpDay(d, start) >= 0 && cmpDay(d, end) <= 0;
  };

  const onPick = (d: JDate) => {
    if (mode === 'single') { setStart(d); return; }
    if (!start || (start && end)) { setStart(d); setEnd(null); return; }
    if (cmpDay(d, start) < 0) { setEnd(start); setStart(d); }
    else { setEnd(d); }
  };

  const shift = (dm: number) => {
    let jm = view.jm + dm, jy = view.jy;
    while (jm < 1) { jm += 12; jy -= 1; }
    while (jm > 12) { jm -= 12; jy += 1; }
    setView({ jy, jm });
  };

  const ready = mode === 'single' ? !!start : !!(start && end);
  const handleOk = () => {
    if (mode === 'single' && start) onConfirm({ mode: 'single', start, end: null });
    else if (mode === 'range' && start && end) onConfirm({ mode: 'range', start, end });
  };

  return (
    <div dir="rtl" className="rounded-lg border border-line bg-panel2/80 p-3 mt-2 w-full max-w-[320px] shadow-sm">
      {label && <div dir="auto" className="text-[12px] text-ink-2 mb-2 text-right">{label}</div>}
      <div className="flex items-center justify-between mb-2">
        <button type="button" className="btn-ghost btn-sm px-2 py-1" onClick={() => shift(+1)} aria-label="next month">‹</button>
        <button type="button" className="text-sm font-medium tracking-tightish" onClick={() => setView({ jy: today.jy, jm: today.jm })}>
          {JALALI_MONTHS_FA[view.jm - 1]} {toPersianDigits(view.jy)}
        </button>
        <button type="button" className="btn-ghost btn-sm px-2 py-1" onClick={() => shift(-1)} aria-label="previous month">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted mb-1">
        {JALALI_WEEKDAYS_FA.map(w => <div key={w}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {gridDays.map((d, i) => {
          if (!d) return <div key={i} className="h-7" />;
          const isToday = sameDay(d, today);
          const isStart = start && sameDay(d, start);
          const isEnd = end && sameDay(d, end);
          const within = inRange(d);
          const cls = [
            'h-7 text-[12px] rounded-md transition-colors',
            (isStart || isEnd) ? 'bg-accent text-white font-medium'
              : within ? 'bg-accent/25 text-ink'
              : isToday ? 'border border-accent/60 text-ink'
              : 'hover:bg-panel/60 text-ink-2',
          ].join(' ');
          return (
            <button key={i} type="button" className={cls} onClick={() => onPick(d)}>
              {toPersianDigits(d.jd)}
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-muted text-right min-h-[16px]">
        {mode === 'single' && start && <span>{formatJalaliLong(start)} ({formatJalaliISO(start)})</span>}
        {mode === 'range' && start && (
          <span>
            {formatJalaliISO(start)}{end ? <> → {formatJalaliISO(end)}</> : <> → …</>}
          </span>
        )}
        {fieldHint && <span className="ms-2 text-2xs text-muted">/ {fieldHint}</span>}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <button type="button" className="btn-ghost btn-sm" onClick={() => { setStart(today); setEnd(null); setView({ jy: today.jy, jm: today.jm }); }}>
            امروز
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => { setStart(null); setEnd(null); }}>
            پاک‌سازی
          </button>
        </div>
        <div className="flex gap-1">
          <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>لغو</button>
          <button type="button" className="btn-primary btn-sm" disabled={!ready} onClick={handleOk}>تأیید</button>
        </div>
      </div>
    </div>
  );
}
