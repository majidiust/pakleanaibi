'use client';
import { useEffect, useState } from 'react';

type Role = 'admin' | 'analyst' | 'viewer';
interface User { id: string; email: string; name: string; role: Role; createdAt?: string }

export function UsersClient({ meId }: { meId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch('/api/users');
    if (r.ok) setUsers((await r.json()).users);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function remove(u: User) {
    if (!confirm(`Delete ${u.email}?`)) return;
    const r = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
    if (!r.ok) setErr((await r.json()).error ?? 'delete failed');
    else void load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="text-sm text-muted">Manage panel users and their roles.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>New user</button>
      </div>
      {err && <div className="card card-pad text-err text-sm">{err}</div>}
      <div className="card">
        <div className="table-wrap rounded-b-none">
          <table className="bi">
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th></th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={4} className="text-muted text-center py-6">Loading…</td></tr>}
              {!loading && users.length === 0 && (
                <tr><td colSpan={4} className="text-muted text-center py-6">No users.</td></tr>
              )}
              {users.map(u => (
                <tr key={u.id}>
                  <td className="font-mono">{u.email}</td>
                  <td>{u.name}</td>
                  <td><span className="pill">{u.role}</span></td>
                  <td className="text-right space-x-2">
                    <button className="btn-ghost text-xs" onClick={() => setEditing(u)}>Edit</button>
                    <button className="btn-danger text-xs" disabled={u.id === meId} onClick={() => remove(u)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {showCreate && <UserModal mode="create" onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); void load(); }} />}
      {editing && <UserModal mode="edit" user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function UserModal({ mode, user, onClose, onSaved }: {
  mode: 'create' | 'edit';
  user?: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'viewer');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const url = mode === 'create' ? '/api/users' : `/api/users/${user!.id}`;
      const method = mode === 'create' ? 'POST' : 'PATCH';
      const body: Record<string, unknown> = mode === 'create'
        ? { email, name, role, password }
        : { name, role, ...(password ? { password } : {}) };
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { setErr((await r.json()).error ?? 'failed'); return; }
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 grid place-items-center p-4 z-50">
      <form onSubmit={save} className="card card-pad w-full max-w-md space-y-3">
        <div className="font-medium">{mode === 'create' ? 'New user' : `Edit ${user!.email}`}</div>
        {mode === 'create' && (
          <div><div className="label mb-1">Email</div><input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></div>
        )}
        <div><div className="label mb-1">Name</div><input className="input" required value={name} onChange={e => setName(e.target.value)} /></div>
        <div><div className="label mb-1">Role</div>
          <select className="input" value={role} onChange={e => setRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="analyst">analyst</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div><div className="label mb-1">{mode === 'create' ? 'Password' : 'New password (leave blank to keep)'}</div>
          <input className="input" type="password" minLength={mode === 'create' ? 8 : 0} required={mode === 'create'} value={password} onChange={e => setPassword(e.target.value)} />
        </div>
        {err && <div className="text-sm text-err">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
