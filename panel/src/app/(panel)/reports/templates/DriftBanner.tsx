'use client';
import { useState } from 'react';
import type { TemplateRelationshipRef } from './types';

export function DriftBanner({ missing }: { missing: TemplateRelationshipRef[] }) {
  const [open, setOpen] = useState(false);
  if (missing.length === 0) return null;
  return (
    <div className="surface border-warn/50 bg-warn/5 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm text-warn font-medium">
            ⚠ Relationships changed since this template was saved
          </div>
          <div className="text-xs text-muted mt-1">
            {missing.length} relationship{missing.length === 1 ? '' : 's'} used by this query
            {missing.length === 1 ? ' is' : ' are'} no longer approved. Running it may return
            different rows than expected, or fail outright.
          </div>
        </div>
        <button className="btn-subtle btn-sm" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide' : 'What changed?'}
        </button>
      </div>
      {open && (
        <ul className="mt-3 space-y-1 text-xs text-ink-2">
          {missing.map(r => (
            <li key={r.fingerprint} className="font-mono">
              <span className="text-muted">missing</span>{' '}
              {r.source.collection}.{r.source.field}
              <span className="text-muted-2"> → </span>
              {r.target.collection}.{r.target.field}
              <span className="text-muted-2"> ({r.type})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
