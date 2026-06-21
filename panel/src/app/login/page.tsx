'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Stage = 'password' | 'totp';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('password');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(j.error === 'invalid_credentials' ? 'Incorrect email or password.' : 'Sign in failed.');
        return;
      }
      if (j.totpRequired && j.pendingToken) {
        setPendingToken(j.pendingToken);
        setStage('totp');
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingToken) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingToken, code }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (j.error === 'pending_expired') {
          setErr('Session expired. Sign in again.');
          setStage('password'); setPendingToken(null); setCode('');
        } else {
          setErr(j.error === 'invalid_code' ? 'Invalid authenticator code.' : 'Verification failed.');
        }
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="card w-full max-w-md card-pad">
        <div className="mb-6">
          <div className="text-xl font-semibold">Paklean BI</div>
          <div className="text-sm text-muted">
            {stage === 'password'
              ? 'Sign in to access reporting and analytics.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </div>
        </div>
        {stage === 'password' ? (
          <form onSubmit={submitPassword} className="space-y-4">
            <div>
              <div className="label mb-1">Email</div>
              <input className="input" type="email" autoComplete="email" required
                value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div>
              <div className="label mb-1">Password</div>
              <input className="input" type="password" autoComplete="current-password" required
                value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {err && <div className="text-sm text-err">{err}</div>}
            <button className="btn-primary w-full" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="space-y-4">
            <div>
              <div className="label mb-1">Authenticator code</div>
              <input className="input tracking-[0.5em] text-center font-mono text-lg"
                inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            {err && <div className="text-sm text-err">{err}</div>}
            <button className="btn-primary w-full" disabled={busy || code.length !== 6} type="submit">
              {busy ? 'Verifying…' : 'Verify'}
            </button>
            <button type="button" className="btn-ghost w-full text-xs"
              onClick={() => { setStage('password'); setPendingToken(null); setCode(''); setErr(null); }}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
