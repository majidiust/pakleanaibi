import { currentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { AccountClient } from './AccountClient';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const me = await currentUser();
  if (!me) redirect('/login');
  return (
    <div className="space-y-6">
      <div>
        <div className="text-xl font-semibold">My account</div>
        <div className="text-sm text-muted">Profile and security settings.</div>
      </div>
      <div className="card card-pad">
        <div className="label mb-2">Profile</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 text-sm">
          <div className="text-muted">Name</div><div>{me.name}</div>
          <div className="text-muted">Email</div><div>{me.email}</div>
          <div className="text-muted">Role</div><div><span className="pill">{me.role}</span></div>
        </div>
      </div>
      <AccountClient />
    </div>
  );
}
