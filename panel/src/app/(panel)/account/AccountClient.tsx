'use client';
import { useEffect, useState } from 'react';

interface Status { enabled: boolean; enrolledAt: string | null; setupInProgress: boolean }
interface Setup { secret: string; uri: string; qrDataUrl: string }

export function AccountClient() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadStatus() {
    const r = await fetch('/api/auth/totp/status');
    if (r.ok) setStatus(await r.json());
  }
  useEffect(() => { loadStatus(); }, []);

  async function startSetup() {
    setErr(null); setMsg(null); setBusy('setup');
    try {
      const r = await fetch('/api/auth/totp/setup', { method: 'POST' });
      if (!r.ok) { setErr('Could not start setup.'); return; }
      setSetup(await r.json());
    } finally { setBusy(null); }
  }

  async function confirmEnable() {
    setErr(null); setMsg(null); setBusy('enable');
    try {
      const r = await fetch('/api/auth/totp/enable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error === 'invalid_code' ? 'Invalid code. Try again.' : 'Could not enable 2FA.');
        return;
      }
      setMsg('Two-factor authentication enabled.');
      setSetup(null); setCode('');
      await loadStatus();
    } finally { setBusy(null); }
  }

  async function disable() {
    setErr(null); setMsg(null); setBusy('disable');
    try {
      const r = await fetch('/api/auth/totp/disable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, code }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const m: Record<string, string> = {
          invalid_password: 'Incorrect password.',
          invalid_code: 'Invalid authenticator code.',
          not_enabled: '2FA is not enabled.',
        };
        setErr(m[j.error] ?? 'Could not disable 2FA.');
        return;
      }
      setMsg('Two-factor authentication disabled.');
      setPassword(''); setCode('');
      await loadStatus();
    } finally { setBusy(null); }
  }

  return (
    <div className="card card-pad space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="label">Two-factor authentication</div>
          <div className="text-sm mt-1">
            {status?.enabled
              ? <>Enabled · enrolled {status.enrolledAt ? new Date(status.enrolledAt).toLocaleDateString() : '—'}</>
              : 'Not enabled. Protect your account with Google Authenticator or any TOTP app.'}
          </div>
        </div>
        <div>
          {status?.enabled
            ? <span className="pill text-ok border-ok/40">on</span>
            : <span className="pill">off</span>}
        </div>
      </div>

      {err && <div className="text-sm text-err">{err}</div>}
      {msg && <div className="text-sm text-ok">{msg}</div>}

      {!status?.enabled && !setup && (
        <button className="btn-primary" disabled={busy !== null} onClick={startSetup}>
          {busy === 'setup' ? 'Generating…' : 'Set up 2FA'}
        </button>
      )}

      {!status?.enabled && setup && (
        <div className="space-y-3">
          <div className="text-sm text-muted">
            Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt="TOTP QR" className="w-48 h-48 bg-white rounded-md p-2" />
          <div className="text-xs text-muted">
            Or paste this secret manually: <span className="font-mono text-ink">{setup.secret}</span>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <div className="label mb-1">6-digit code</div>
              <input className="input tracking-[0.4em] text-center font-mono"
                inputMode="numeric" maxLength={6}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            <button className="btn-primary" disabled={code.length !== 6 || busy !== null}
              onClick={confirmEnable}>
              {busy === 'enable' ? 'Enabling…' : 'Enable'}
            </button>
            <button className="btn-ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {status?.enabled && (
        <div className="space-y-3">
          <div className="text-sm text-muted">
            To disable 2FA, confirm with your password and a current authenticator code.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="label mb-1">Password</div>
              <input className="input" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <div>
              <div className="label mb-1">Authenticator code</div>
              <input className="input tracking-[0.4em] text-center font-mono"
                inputMode="numeric" maxLength={6}
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
          <button className="btn-danger" disabled={!password || code.length !== 6 || busy !== null}
            onClick={disable}>
            {busy === 'disable' ? 'Disabling…' : 'Disable 2FA'}
          </button>
        </div>
      )}
    </div>
  );
}
