import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { UsersClient } from './UsersClient';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (u.role !== 'admin') {
    return (
      <div className="card card-pad">
        <div className="font-medium">Access restricted</div>
        <div className="text-sm text-muted mt-1">User management requires the admin role.</div>
      </div>
    );
  }
  return <UsersClient meId={u.sub} />;
}
